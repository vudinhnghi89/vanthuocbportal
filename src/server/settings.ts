import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import { INTEGRATION_KEYS, integrationSettings, settingsAudit, users } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { DifyConfigError, scrubKey, type DifySettings } from "@/integrations/dify/client";
import type { DbLike } from "./rules";

export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];
export const isIntegrationKey = (v: unknown): v is IntegrationKey =>
  typeof v === "string" && (INTEGRATION_KEYS as readonly string[]).includes(v);

/** Cấu hình chưa có hoặc chưa đủ (worker dùng để biết cần báo admin). */
export class DifyNotConfiguredError extends DifyConfigError {
  constructor(readonly key: IntegrationKey) {
    super(`Chưa cấu hình tích hợp Dify (${key})`);
  }
}

export type SettingsErrorCode =
  | "invalid_base_url"
  | "invalid_var"
  | "invalid_timeout"
  | "invalid_retries"
  | "invalid_budget"
  | "invalid_api_key"
  | "api_key_required"
  | "api_key_unreadable";

const MESSAGES: Record<SettingsErrorCode, string> = {
  invalid_base_url: "Địa chỉ Dify phải là URL http hoặc https hợp lệ",
  invalid_var: "Tên biến không được để trống và tối đa 100 ký tự",
  invalid_timeout: "Thời gian chờ phải là số nguyên từ 1 đến 600 giây",
  invalid_retries: "Số lần thử lại phải là số nguyên từ 0 đến 10",
  invalid_budget: "Tổng thời gian chờ tối đa vượt giới hạn",
  invalid_api_key: "API key không hợp lệ",
  api_key_required: "API key là bắt buộc khi cấu hình lần đầu",
  api_key_unreadable: "API key đã lưu không đọc được (APP_SECRET đã đổi?): hãy nhập lại API key để lưu",
};

export const KEY_UNREADABLE_MESSAGE = "Không giải mã được API key đã lưu — kiểm tra APP_SECRET hoặc nhập lại key";

/** API key đã lưu nhưng không giải mã được (APP_SECRET đổi hoặc dữ liệu hỏng). Không chứa key hay ciphertext. */
export class KeyUnreadableError extends DifyConfigError {
  constructor() {
    super(KEY_UNREADABLE_MESSAGE);
    this.name = "KeyUnreadableError";
  }
}

function decryptStoredKey(enc: string): string {
  try {
    return decryptSecret(enc);
  } catch {
    throw new KeyUnreadableError();
  }
}

/**
 * Công việc hàng đợi hết hạn sau 3600 giây (OCR_EXPIRE_SECONDS). Mỗi lần thử gọi Dify hai yêu cầu (tải lên + chạy
 * workflow), mỗi yêu cầu chờ tối đa timeoutS giây, nên ngân sách xấu nhất = 2 × timeoutS × (retries + 1) phải nhỏ hơn
 * hạn đó (chừa ~300 giây dự phòng), nếu không pg-boss giao lại job khi handler cũ còn đang chạy.
 */
export const MAX_DIFY_BUDGET_S = 3300;
export const difyBudgetS = (timeoutS: number, retries: number) => 2 * timeoutS * (retries + 1);

export class SettingsError extends Error {
  constructor(
    public readonly code: SettingsErrorCode,
    message?: string,
  ) {
    super(message ?? MESSAGES[code]);
    this.name = "SettingsError";
  }
}

export type DifySettingsInput = {
  baseUrl: string;
  /** Bỏ trống/undefined khi cập nhật = giữ key hiện có. */
  apiKey?: string;
  inputVar: string;
  outputVarMd: string;
  outputVarJson: string;
  timeoutS: number;
  retries: number;
};

export type DifySettingsView = {
  baseUrl: string;
  apiKeyMasked: string | null;
  /** none: chưa có key; ok: đọc được; unreadable: có key nhưng không giải mã được (phải nhập lại). */
  keyStatus: "none" | "ok" | "unreadable";
  inputVar: string;
  outputVarMd: string;
  outputVarJson: string;
  timeoutS: number;
  retries: number;
  updatedAt: Date | null;
  updatedBy: string | null;
};

type Row = typeof integrationSettings.$inferSelect;
type Fields = Omit<DifySettings, "apiKey">;

const MAX_VAR = 100;

const MIN_MASKABLE = 12;

/** Chỉ lộ 4 ký tự cuối (`app-****abcd`) khi phần sau tiền tố `app-` dài ít nhất 12 ký tự; còn lại che hoàn toàn. */
export function maskKey(key: string): string {
  const prefix = key.startsWith("app-") ? "app-" : "";
  if (key.length - prefix.length < MIN_MASKABLE) return "****";
  return `${prefix}****${key.slice(-4)}`;
}

function maskedFromRow(row: Row): string | null {
  if (!row.apiKeyEnc) return null;
  try {
    return maskKey(decryptSecret(row.apiKeyEnc));
  } catch {
    return "****";
  }
}

function keyStatusOf(row: Row): { keyStatus: DifySettingsView["keyStatus"]; apiKeyMasked: string | null } {
  if (!row.apiKeyEnc) return { keyStatus: "none", apiKeyMasked: null };
  try {
    return { keyStatus: "ok", apiKeyMasked: maskKey(decryptSecret(row.apiKeyEnc)) };
  } catch {
    return { keyStatus: "unreadable", apiKeyMasked: null };
  }
}

function cleanVar(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > MAX_VAR) throw new SettingsError("invalid_var");
  return v.trim();
}

function cleanFields(input: DifySettingsInput): Fields {
  let baseUrl = typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "";
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    if (u.username || u.password || u.search || u.hash) throw new Error();
  } catch {
    throw new SettingsError("invalid_base_url");
  }
  baseUrl = baseUrl.replace(/\/+$/, "");
  const inputVar = cleanVar(input.inputVar);
  const outputVarMd = cleanVar(input.outputVarMd);
  const outputVarJson = cleanVar(input.outputVarJson);
  if (!Number.isInteger(input.timeoutS) || input.timeoutS < 1 || input.timeoutS > 600) {
    throw new SettingsError("invalid_timeout");
  }
  if (!Number.isInteger(input.retries) || input.retries < 0 || input.retries > 10) {
    throw new SettingsError("invalid_retries");
  }
  const budget = difyBudgetS(input.timeoutS, input.retries);
  if (budget > MAX_DIFY_BUDGET_S) {
    throw new SettingsError(
      "invalid_budget",
      `Tổng thời gian chờ tối đa = 2 × thời gian chờ × (số lần thử lại + 1) = ${budget} giây, vượt giới hạn ${MAX_DIFY_BUDGET_S} giây ` +
        "(công việc hết hạn sau 3600 giây). Hãy giảm thời gian chờ hoặc số lần thử lại",
    );
  }
  return { baseUrl, inputVar, outputVarMd, outputVarJson, timeoutS: input.timeoutS, retries: input.retries };
}

const FIELD_KEYS = ["baseUrl", "inputVar", "outputVarMd", "outputVarJson", "timeoutS", "retries"] as const;

/** Allow-list of public fields only; never spread a DB row (it carries the ciphertext). */
function maskedSnapshot(f: Fields, apiKeyMasked: string | null) {
  return {
    baseUrl: f.baseUrl,
    inputVar: f.inputVar,
    outputVarMd: f.outputVarMd,
    outputVarJson: f.outputVarJson,
    timeoutS: f.timeoutS,
    retries: f.retries,
    apiKeyMasked,
  };
}

/** Đọc cấu hình đã giải mã cho worker; ném DifyNotConfiguredError nếu thiếu/chưa đủ. */
export async function getDifySettings(key: IntegrationKey, db: DbLike = defaultDb): Promise<DifySettings> {
  const [row] = await db.select().from(integrationSettings).where(eq(integrationSettings.key, key));
  if (!row || !row.baseUrl || !row.apiKeyEnc || !row.inputVar || !row.outputVarMd || !row.outputVarJson) {
    throw new DifyNotConfiguredError(key);
  }
  return {
    baseUrl: row.baseUrl,
    apiKey: decryptStoredKey(row.apiKeyEnc),
    inputVar: row.inputVar,
    outputVarMd: row.outputVarMd,
    outputVarJson: row.outputVarJson,
    timeoutS: row.timeoutS,
    retries: row.retries,
  };
}

/** View công khai: KHÔNG bao giờ chứa key hay ciphertext. */
export async function getDifySettingsView(key: IntegrationKey, db: DbLike = defaultDb): Promise<DifySettingsView> {
  const [r] = await db
    .select({ row: integrationSettings, username: users.username })
    .from(integrationSettings)
    .leftJoin(users, eq(users.id, integrationSettings.updatedBy))
    .where(eq(integrationSettings.key, key));
  if (!r) {
    return {
      baseUrl: "",
      apiKeyMasked: null,
      keyStatus: "none",
      inputVar: "",
      outputVarMd: "",
      outputVarJson: "",
      timeoutS: 0,
      retries: 0,
      updatedAt: null,
      updatedBy: null,
    };
  }
  const { row } = r;
  return {
    baseUrl: row.baseUrl,
    ...keyStatusOf(row),
    inputVar: row.inputVar,
    outputVarMd: row.outputVarMd,
    outputVarJson: row.outputVarJson,
    timeoutS: row.timeoutS,
    retries: row.retries,
    updatedAt: row.updatedAt,
    updatedBy: r.username ?? null,
  };
}

/** Lưu cấu hình + đúng một bản audit (đã che) trong cùng giao dịch; không đổi gì thì không ghi gì. */
export async function saveDifySettings(
  key: IntegrationKey,
  input: DifySettingsInput,
  actorId: number,
  db: DbLike = defaultDb,
): Promise<void> {
  const fields = cleanFields(input);
  const rawKey = input.apiKey;
  if (rawKey !== undefined && rawKey !== null && typeof rawKey !== "string") throw new SettingsError("invalid_api_key");
  const newKey = typeof rawKey === "string" && rawKey.trim() ? rawKey.trim() : null;

  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(integrationSettings).where(eq(integrationSettings.key, key)).for("update");
    if (!current?.apiKeyEnc && !newKey) throw new SettingsError("api_key_required");
    // Key đã lưu mà không đọc được: không giữ ciphertext hỏng một cách im lặng, bắt buộc nhập lại.
    if (current?.apiKeyEnc && !newKey && keyStatusOf(current).keyStatus === "unreadable") {
      throw new SettingsError("api_key_unreadable");
    }

    let keyChanged = false;
    let apiKeyEnc = current?.apiKeyEnc ?? null;
    let afterMask = current ? maskedFromRow(current) : null;
    if (newKey) {
      let same = false;
      if (current?.apiKeyEnc) {
        try {
          same = decryptSecret(current.apiKeyEnc) === newKey;
        } catch {
          same = false;
        }
      }
      if (!same) {
        keyChanged = true;
        apiKeyEnc = encryptSecret(newKey);
        afterMask = maskKey(newKey);
      }
    }

    const fieldsChanged = !current || FIELD_KEYS.some((k) => current[k] !== fields[k]);
    if (!fieldsChanged && !keyChanged) return;

    const values = { ...fields, apiKeyEnc, updatedBy: actorId, updatedAt: sql`clock_timestamp()` };
    await tx
      .insert(integrationSettings)
      .values({ key, ...values })
      .onConflictDoUpdate({ target: integrationSettings.key, set: values });
    await tx.insert(settingsAudit).values({
      key,
      actorId,
      beforeMasked: current ? maskedSnapshot(current, maskedFromRow(current)) : null,
      afterMasked: { ...maskedSnapshot(fields, afterMask), apiKeyChanged: keyChanged },
      at: sql`clock_timestamp()`,
    });
  });
}

const TEST_TIMEOUT_MS = 10_000;

/** Gọi GET {baseUrl}/parameters (không chạy workflow) để kiểm tra URL + key. Thông báo không chứa key. */
export async function testConnection(
  key: IntegrationKey,
  db: DbLike = defaultDb,
): Promise<{ ok: boolean; message: string }> {
  let cfg: DifySettings;
  try {
    cfg = await getDifySettings(key, db);
  } catch (e) {
    if (e instanceof DifyNotConfiguredError) return { ok: false, message: "Chưa cấu hình đầy đủ: cần địa chỉ, API key và tên biến" };
    if (e instanceof KeyUnreadableError) return { ok: false, message: e.message };
    return { ok: false, message: "Không đọc được cấu hình (kiểm tra APP_SECRET)" };
  }
  const result = await probe(cfg);
  return { ok: result.ok, message: scrubKey(result.message, cfg.apiKey) };
}

async function probe(cfg: DifySettings): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/parameters`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      redirect: "manual",
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, message: "Dify trả về chuyển hướng, kiểm tra lại Base URL" };
    }
    if (res.ok) return { ok: true, message: "Kết nối thành công" };
    if (res.status === 401 || res.status === 403) return { ok: false, message: "API key không hợp lệ" };
    return { ok: false, message: `Dify trả về lỗi HTTP ${res.status}` };
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, message: "Dify không phản hồi trong 10 giây" };
    }
    return { ok: false, message: "Không kết nối được tới Dify" };
  }
}
