import { eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import { documents } from "@/db/schema";
import { DifyConfigError, DifyHttpError, runOcr as defaultRunOcr, scrubKey } from "@/integrations/dify/client";
import { InvalidStateError, SecretariatMissingError, runRuleCheck as defaultRunRuleCheck } from "@/matching/run";
import { DifyNotConfiguredError, getDifySettings } from "@/server/settings";
import { DocumentNotFoundError, InvalidTransitionError, transition, type DbLike } from "@/server/status";
import { saveMarkdown } from "@/server/storage";
import fs from "node:fs/promises";

export type OcrJobMeta = { retryCount: number; retryLimit: number };

export type OcrJobDeps = {
  db?: DbLike;
  runOcr?: typeof defaultRunOcr;
  runRuleCheck?: typeof defaultRunRuleCheck;
};

const MAX_MESSAGE = 300;
const DEAD_MESSAGE = "Công việc OCR bị hủy hoặc hết thời gian chờ";

/** Lỗi không thể khắc phục bằng thử lại: đánh dấu failed ngay. Trả về thông báo tiếng Việt, hoặc null nếu là lỗi tạm thời. */
function permanentSummary(err: unknown): string | null {
  if (err instanceof DifyNotConfiguredError) return "Chưa cấu hình tích hợp OCR (Dify)";
  if (err instanceof DifyConfigError) return "Cấu hình tích hợp OCR (Dify) không hợp lệ";
  if ((err as { code?: string } | null)?.code === "ENOENT") return "Không tìm thấy hoặc không đọc được tệp PDF";
  if (err instanceof SecretariatMissingError) return "Chưa cấu hình đơn vị Ban thư ký";
  if (err instanceof DifyHttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
    return `Dify từ chối yêu cầu (HTTP ${err.status}), kiểm tra cấu hình tích hợp`;
  }
  return null;
}

function failureMessage(summary: string, err: unknown, apiKey: string | null): string {
  const e = err as { name?: string; message?: string } | null;
  const name = e?.name || "Error";
  let msg = String(e?.message ?? "");
  if (apiKey) msg = scrubKey(msg, apiKey);
  msg = msg.length > MAX_MESSAGE ? `${msg.slice(0, MAX_MESSAGE)}…` : msg;
  return `${summary} [${name}] ${msg}`.trim();
}

function errName(err: unknown): string {
  return (err as { name?: string } | null)?.name || "Error";
}

/**
 * Đánh dấu failed. queued -> failed KHÔNG phải cạnh hợp lệ nên đi qua ocr_processing (hai event).
 * Nuốt InvalidTransitionError/DocumentNotFoundError (văn bản đã được xử lý hướng khác) và chỉ log.
 */
async function markFailed(documentId: string, error: string, db: DbLike): Promise<void> {
  try {
    const [d] = await db.select({ status: documents.status }).from(documents).where(eq(documents.id, documentId));
    if (!d) return;
    if (d.status === "queued") await transition(documentId, "ocr_processing", { note: "Lỗi trước khi bắt đầu OCR" }, db);
    await transition(documentId, "failed", { error }, db);
  } catch (e) {
    if (e instanceof InvalidTransitionError || e instanceof DocumentNotFoundError) {
      console.warn(`[ocr] ${documentId}: không thể đánh dấu failed (${errName(e)})`);
      return;
    }
    throw e;
  }
}

/** Bước OCR: gọi Dify, lưu md rồi cập nhật md_path/extracted + chuyển rule_checking trong MỘT giao dịch. */
async function ocrStep(
  documentId: string,
  pdfPath: string,
  db: DbLike,
  runOcr: typeof defaultRunOcr,
  keyBox: { key: string | null },
): Promise<void> {
  const settings = await getDifySettings("dify_ocr", db);
  keyBox.key = settings.apiKey;
  const { markdown, json } = await runOcr(settings, pdfPath);
  const mdPath = await saveMarkdown(markdown);
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(documents)
        .set({ mdPath, extracted: json as never, updatedAt: sql`clock_timestamp()` as never })
        .where(eq(documents.id, documentId));
      await transition(documentId, "rule_checking", {}, tx as unknown as DbLike);
    });
  } catch (e) {
    await fs.rm(mdPath, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Xử lý một job OCR; có thể chạy lại an toàn khi pg-boss giao lại job (xem bảng trạng thái trong spec §6).
 * Lỗi vĩnh viễn -> failed ngay; lỗi tạm thời -> throw để pg-boss thử lại, riêng lần cuối thì failed và KHÔNG throw.
 */
export async function handleOcrJob(documentId: string, meta: OcrJobMeta, deps: OcrJobDeps = {}): Promise<void> {
  const db = deps.db ?? defaultDb;
  const runOcr = deps.runOcr ?? defaultRunOcr;
  const runRuleCheck = deps.runRuleCheck ?? defaultRunRuleCheck;

  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) {
    console.warn(`[ocr] ${documentId}: văn bản không tồn tại, bỏ qua job`);
    return;
  }
  if (doc.status !== "queued" && doc.status !== "ocr_processing" && doc.status !== "rule_checking") return;

  const keyBox: { key: string | null } = { key: null };
  try {
    if (doc.status === "queued") await transition(documentId, "ocr_processing", {}, db);
    if (doc.status !== "rule_checking") await ocrStep(documentId, doc.pdfPath, db, runOcr, keyBox);
    await runRuleCheck(documentId, { db });
  } catch (err) {
    // Văn bản đã bị xử lý hướng khác (hủy/failed/đã phân loại) trong lúc job chạy: không còn việc gì.
    if (err instanceof InvalidTransitionError || err instanceof InvalidStateError || err instanceof DocumentNotFoundError) {
      console.warn(`[ocr] ${documentId}: văn bản đã chuyển trạng thái (${errName(err)}), bỏ qua`);
      return;
    }
    const permanent = permanentSummary(err);
    const lastAttempt = meta.retryCount >= meta.retryLimit;
    if (permanent === null && !lastAttempt) {
      console.error(`[ocr] ${documentId}: lỗi tạm thời (${errName(err)}), sẽ thử lại`);
      throw err;
    }
    const summary = permanent ?? "Xử lý OCR thất bại sau nhiều lần thử";
    console.error(`[ocr] ${documentId}: đánh dấu failed (${errName(err)})`);
    await markFailed(documentId, failureMessage(summary, err, keyBox.key), db);
  }
}

/**
 * Job nằm trong hàng đợi chết: pg-boss đã hết lượt (hết hạn, bị kill) mà handler không còn được gọi.
 * Văn bản còn dở dang thì đánh dấu failed; trạng thái khác hoặc id lạ thì bỏ qua.
 */
export async function handleDeadOcrJob(documentId: string, deps: { db?: DbLike } = {}): Promise<void> {
  const db = deps.db ?? defaultDb;
  const [d] = await db.select({ status: documents.status }).from(documents).where(eq(documents.id, documentId));
  if (!d) {
    console.warn(`[ocr] ${documentId}: job chết của văn bản không tồn tại, bỏ qua`);
    return;
  }
  if (d.status !== "queued" && d.status !== "ocr_processing" && d.status !== "rule_checking") return;
  await markFailed(documentId, DEAD_MESSAGE, db);
}
