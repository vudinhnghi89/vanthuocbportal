import { asc, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import { issuerAliases } from "@/db/schema";
import { normalize, type Alias } from "@/matching/normalize";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/db/schema";

export type IssuerAlias = typeof issuerAliases.$inferSelect;
type DbLike = NodePgDatabase<typeof schema>;

export type AliasErrorCode =
  | "invalid_alias"
  | "invalid_canonical"
  | "too_long"
  | "same_as_canonical"
  | "duplicate_alias"
  | "alias_chain"
  | "not_found";

const MESSAGES: Record<AliasErrorCode, string> = {
  invalid_alias: "Bí danh không được để trống hoặc chứa ký tự không hợp lệ",
  invalid_canonical: "Tên cơ quan chuẩn không được để trống hoặc chứa ký tự không hợp lệ",
  too_long: "Bí danh và tên cơ quan chuẩn tối đa 200 ký tự",
  same_as_canonical: "Bí danh trùng với tên cơ quan chuẩn sau khi chuẩn hóa",
  duplicate_alias: "Bí danh đã tồn tại",
  alias_chain: "Bí danh không được tạo chuỗi với các bí danh khác",
  not_found: "Không tìm thấy bí danh",
};

export class AliasError extends Error {
  constructor(public readonly code: AliasErrorCode) {
    super(MESSAGES[code]);
    this.name = "AliasError";
  }
}

const MAX_LEN = 200;
const ALIAS_LOCK = 5_100_001; // khóa advisory tuần tự hóa việc tạo bí danh (kiểm tra chuỗi)
const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === UNIQUE_VIOLATION || err?.cause?.code === UNIQUE_VIOLATION;
};
const hasNul = (s: string) => /\u0000/.test(s);

export async function listAliases(db: DbLike = defaultDb): Promise<IssuerAlias[]> {
  return db.select().from(issuerAliases).orderBy(asc(issuerAliases.alias), asc(issuerAliases.id));
}

/** Danh sách cho bộ so khớp (T-5.2). */
export async function loadAliases(db: DbLike = defaultDb): Promise<Alias[]> {
  const rows = await listAliases(db);
  return rows.map((r) => ({ alias: r.alias, canonicalIssuer: r.canonicalIssuer }));
}

/** actorId nhận để thống nhất chữ ký; chưa có bảng audit cho bí danh nên chưa dùng. */
export async function createAlias(
  alias: string,
  canonicalIssuer: string,
  actorId?: number,
  db: DbLike = defaultDb,
): Promise<IssuerAlias> {
  void actorId;
  const a = alias.trim();
  const c = canonicalIssuer.trim();
  const aliasNorm = normalize(a);
  const canonNorm = normalize(c);
  if (!a || !aliasNorm || hasNul(a)) throw new AliasError("invalid_alias");
  if (!c || !canonNorm || hasNul(c)) throw new AliasError("invalid_canonical");
  if (a.length > MAX_LEN || c.length > MAX_LEN) throw new AliasError("too_long");
  if (aliasNorm === canonNorm) throw new AliasError("same_as_canonical");

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ALIAS_LOCK})`);
      const rows = await tx.select().from(issuerAliases);
      if (rows.some((r) => r.aliasNorm === aliasNorm)) throw new AliasError("duplicate_alias");
      const chain = rows.some((r) => normalize(r.canonicalIssuer) === aliasNorm || r.aliasNorm === canonNorm);
      if (chain) throw new AliasError("alias_chain");
      const [row] = await tx.insert(issuerAliases).values({ alias: a, canonicalIssuer: c, aliasNorm }).returning();
      return row;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AliasError("duplicate_alias");
    throw e;
  }
}

export async function deleteAlias(id: number, db: DbLike = defaultDb): Promise<void> {
  const rows = await db.delete(issuerAliases).where(eq(issuerAliases.id, id)).returning({ id: issuerAliases.id });
  if (rows.length === 0) throw new AliasError("not_found");
}
