import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import { ruleAudit, rules, units, users } from "@/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/db/schema";

export type Rule = typeof rules.$inferSelect;
export type RuleInput = {
  issuer: string;
  docType: string;
  title: string;
  summary: string;
  mainUnitId: number;
  infoUnitId: number | null;
  priority: number;
};
export type RulePatch = Partial<RuleInput> & { active?: boolean };
export type RuleFilter = { q?: string; active?: boolean };
/** db hoặc tx (drizzle lồng giao dịch bằng savepoint): T-1.3 truyền tx để ghi audit cùng giao dịch. */
export type DbLike = NodePgDatabase<typeof schema>;

export type RuleErrorCode =
  | "invalid_issuer"
  | "invalid_doc_type"
  | "invalid_title"
  | "invalid_summary"
  | "invalid_priority"
  | "invalid_unit"
  | "invalid_active"
  | "not_found";

const MESSAGES: Record<RuleErrorCode, string> = {
  invalid_issuer: "Cơ quan ban hành không được để trống",
  invalid_doc_type: "Loại văn bản không được để trống",
  invalid_title: "Tiêu đề không hợp lệ",
  invalid_summary: "Trích yếu không hợp lệ",
  invalid_priority: "Độ ưu tiên phải là số nguyên trong khoảng ±2147483647",
  invalid_active: "Trạng thái bật/tắt không hợp lệ",
  invalid_unit: "Đơn vị phải tồn tại và đang hoạt động",
  not_found: "Không tìm thấy quy tắc",
};

export class RuleError extends Error {
  constructor(public readonly code: RuleErrorCode) {
    super(MESSAGES[code]);
    this.name = "RuleError";
  }
}

const INT4_MAX = 2147483647;
const isPriority = (v: unknown): v is number => Number.isSafeInteger(v) && Math.abs(v as number) <= INT4_MAX;
const isUnitId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= INT4_MAX;

function requiredText(v: unknown, code: RuleErrorCode): string {
  if (typeof v !== "string" || !v.trim()) throw new RuleError(code);
  return v.trim();
}
function optionalText(v: unknown, code: RuleErrorCode): string {
  if (typeof v !== "string") throw new RuleError(code);
  return v.trim();
}

/** Chuẩn hóa các trường có mặt trong patch (không kiểm tra đơn vị). */
function cleanFields(p: RulePatch): RulePatch {
  const out: RulePatch = {};
  if ("issuer" in p) out.issuer = requiredText(p.issuer, "invalid_issuer");
  if ("docType" in p) out.docType = requiredText(p.docType, "invalid_doc_type");
  if ("title" in p) out.title = optionalText(p.title, "invalid_title");
  if ("summary" in p) out.summary = optionalText(p.summary, "invalid_summary");
  if ("priority" in p) {
    if (!isPriority(p.priority)) throw new RuleError("invalid_priority");
    out.priority = p.priority;
  }
  if ("mainUnitId" in p) {
    if (!isUnitId(p.mainUnitId)) throw new RuleError("invalid_unit");
    out.mainUnitId = p.mainUnitId;
  }
  if ("infoUnitId" in p) {
    if (p.infoUnitId !== null && !isUnitId(p.infoUnitId)) throw new RuleError("invalid_unit");
    out.infoUnitId = p.infoUnitId;
  }
  if ("active" in p) {
    if (typeof p.active !== "boolean") throw new RuleError("invalid_active");
    out.active = p.active;
  }
  return out;
}

async function assertActiveUnits(db: DbLike, ids: Array<number | null | undefined>): Promise<void> {
  const wanted = [...new Set(ids.filter((x): x is number => typeof x === "number"))];
  if (wanted.length === 0) return;
  const found = await db
    .select({ id: units.id })
    .from(units)
    .where(and(inArray(units.id, wanted), eq(units.active, true)));
  if (found.length !== wanted.length) throw new RuleError("invalid_unit");
}

type AuditAction = (typeof ruleAudit.$inferInsert)["action"];

/** Ghi đúng một bản audit trong giao dịch `tx` của thao tác; lỗi ở đây làm hỏng (rollback) cả thao tác. */
async function writeAudit(
  tx: DbLike,
  ruleId: number,
  action: AuditAction,
  actorId: number,
  before: Rule | null,
  after: Rule | null,
): Promise<void> {
  await tx.insert(ruleAudit).values({ ruleId, action, actorId, before, after, at: sql`clock_timestamp()` });
}

export async function createRule(input: RuleInput, actorId: number, db: DbLike = defaultDb): Promise<Rule> {
  // Mọi trường phải có mặt khi tạo: khóa thiếu bị coi là undefined -> bị cleanFields từ chối.
  const full = {
    issuer: input?.issuer,
    docType: input?.docType,
    title: input?.title,
    summary: input?.summary,
    mainUnitId: input?.mainUnitId,
    infoUnitId: input?.infoUnitId ?? null,
    priority: input?.priority,
  } as RuleInput;
  const clean = cleanFields(full) as RuleInput;
  return db.transaction(async (tx) => {
    await assertActiveUnits(tx, [clean.mainUnitId, clean.infoUnitId]);
    const [row] = await tx.insert(rules).values(clean).returning();
    await writeAudit(tx, row.id, "create", actorId, null, row);
    return row;
  });
}

/** Kết quả thao tác sửa: `before` là dòng đọc (FOR UPDATE) trong giao dịch; changed=false -> không ghi gì. */
export type RuleChange = { rule: Rule; before: Rule; changed: boolean };

const EDITABLE = ["issuer", "docType", "title", "summary", "mainUnitId", "infoUnitId", "priority", "active"] as const;

export async function updateRule(
  id: number,
  patch: RulePatch,
  actorId: number,
  db: DbLike = defaultDb,
): Promise<RuleChange> {
  const clean = cleanFields(patch);
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(rules).where(eq(rules.id, id)).for("update");
    if (!current) throw new RuleError("not_found");
    await assertActiveUnits(tx, [clean.mainUnitId, clean.infoUnitId]);
    const diffKeys = EDITABLE.filter((k) => k in clean && clean[k] !== current[k]);
    if (diffKeys.length === 0) return { rule: current, before: current, changed: false };
    const [row] = await tx
      .update(rules)
      .set({ ...clean, updatedAt: sql`clock_timestamp()` })
      .where(eq(rules.id, id))
      .returning();
    const action: AuditAction = diffKeys.length === 1 && diffKeys[0] === "active" ? "toggle" : "update";
    await writeAudit(tx, id, action, actorId, current, row);
    return { rule: row, before: current, changed: true };
  });
}

/** Bật/tắt: ủy quyền cho updateRule (một khóa, một UPDATE, không ghi khi không đổi). */
export async function toggleRule(
  id: number,
  active: boolean,
  actorId: number,
  db: DbLike = defaultDb,
): Promise<RuleChange> {
  if (typeof active !== "boolean") throw new RuleError("invalid_active");
  return updateRule(id, { active }, actorId, db);
}

/** Trả dòng đã xóa (chính là `before` cho audit). */
export async function deleteRule(id: number, actorId: number, db: DbLike = defaultDb): Promise<Rule> {
  return db.transaction(async (tx) => {
    const [row] = await tx.delete(rules).where(eq(rules.id, id)).returning();
    if (!row) throw new RuleError("not_found");
    await writeAudit(tx, id, "delete", actorId, row, null);
    return row;
  });
}

export type AuditEntry = {
  id: number;
  ruleId: number;
  action: AuditAction;
  actorId: number | null;
  actorUsername: string | null;
  before: Rule | null;
  after: Rule | null;
  at: Date;
};

/** Lịch sử chỉnh sửa, mới nhất trước; ruleId bỏ trống = toàn bộ. */
export async function listRuleAudit(
  ruleId?: number,
  opts: { limit?: number; offset?: number } = {},
  db: DbLike = defaultDb,
): Promise<AuditEntry[]> {
  const rows = await db
    .select({
      id: ruleAudit.id,
      ruleId: ruleAudit.ruleId,
      action: ruleAudit.action,
      actorId: ruleAudit.actorId,
      actorUsername: users.username,
      before: ruleAudit.before,
      after: ruleAudit.after,
      at: ruleAudit.at,
    })
    .from(ruleAudit)
    .leftJoin(users, eq(users.id, ruleAudit.actorId))
    .where(ruleId === undefined ? undefined : eq(ruleAudit.ruleId, ruleId))
    .orderBy(desc(ruleAudit.at), desc(ruleAudit.id))
    .limit(opts.limit ?? 200)
    .offset(opts.offset ?? 0);
  return rows as AuditEntry[];
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

export async function listRules(filter: RuleFilter = {}, db: DbLike = defaultDb): Promise<Rule[]> {
  const conds: SQL[] = [];
  const q = filter.q?.trim();
  if (q) {
    const pat = `%${escapeLike(q)}%`;
    conds.push(
      or(ilike(rules.issuer, pat), ilike(rules.docType, pat), ilike(rules.title, pat), ilike(rules.summary, pat))!,
    );
  }
  if (filter.active !== undefined) conds.push(eq(rules.active, filter.active));
  return db
    .select()
    .from(rules)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(rules.priority), asc(rules.issuer), asc(rules.docType), asc(rules.id));
}
