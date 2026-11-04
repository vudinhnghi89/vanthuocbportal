import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import { rules, units } from "@/db/schema";
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
export type RulePatch = Partial<RuleInput>;
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
  | "not_found";

const MESSAGES: Record<RuleErrorCode, string> = {
  invalid_issuer: "Cơ quan ban hành không được để trống",
  invalid_doc_type: "Loại văn bản không được để trống",
  invalid_title: "Tiêu đề không hợp lệ",
  invalid_summary: "Trích yếu không hợp lệ",
  invalid_priority: "Độ ưu tiên phải là số nguyên",
  invalid_unit: "Đơn vị phải tồn tại và đang hoạt động",
  not_found: "Không tìm thấy quy tắc",
};

export class RuleError extends Error {
  constructor(public readonly code: RuleErrorCode) {
    super(MESSAGES[code]);
    this.name = "RuleError";
  }
}

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
    if (!Number.isSafeInteger(p.priority)) throw new RuleError("invalid_priority");
    out.priority = p.priority;
  }
  if ("mainUnitId" in p) {
    if (!Number.isSafeInteger(p.mainUnitId)) throw new RuleError("invalid_unit");
    out.mainUnitId = p.mainUnitId;
  }
  if ("infoUnitId" in p) {
    if (p.infoUnitId !== null && !Number.isSafeInteger(p.infoUnitId)) throw new RuleError("invalid_unit");
    out.infoUnitId = p.infoUnitId;
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

// actorId được nhận ở mọi thao tác để T-1.3 ghi audit (cùng giao dịch); hiện chưa dùng.

export async function createRule(input: RuleInput, _actorId: number, db: DbLike = defaultDb): Promise<Rule> {
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
    return row;
  });
}

export async function updateRule(id: number, patch: RulePatch, _actorId: number, db: DbLike = defaultDb): Promise<Rule> {
  const clean = cleanFields(patch);
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(rules).where(eq(rules.id, id)).for("update");
    if (!current) throw new RuleError("not_found");
    await assertActiveUnits(tx, [clean.mainUnitId, clean.infoUnitId]);
    const [row] = await tx
      .update(rules)
      .set({ ...clean, updatedAt: sql`clock_timestamp()` })
      .where(eq(rules.id, id))
      .returning();
    return row;
  });
}

export async function toggleRule(id: number, active: boolean, _actorId: number, db: DbLike = defaultDb): Promise<Rule> {
  if (typeof active !== "boolean") throw new RuleError("not_found");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(rules)
      .set({ active, updatedAt: sql`clock_timestamp()` })
      .where(eq(rules.id, id))
      .returning();
    if (!row) throw new RuleError("not_found");
    return row;
  });
}

export async function deleteRule(id: number, _actorId: number, db: DbLike = defaultDb): Promise<Rule> {
  return db.transaction(async (tx) => {
    const [row] = await tx.delete(rules).where(eq(rules.id, id)).returning();
    if (!row) throw new RuleError("not_found");
    return row;
  });
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
