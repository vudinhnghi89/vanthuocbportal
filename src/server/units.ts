import { asc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import { units } from "@/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/db/schema";

export type Unit = typeof units.$inferSelect;
export type UnitPatch = { name?: string; active?: boolean };
type DbLike = NodePgDatabase<typeof schema>;

export type UnitErrorCode = "invalid_name" | "duplicate_name" | "not_found" | "secretariat_protected";

const MESSAGES: Record<UnitErrorCode, string> = {
  invalid_name: "Tên đơn vị không được để trống",
  duplicate_name: "Tên đơn vị đã tồn tại",
  not_found: "Không tìm thấy đơn vị",
  secretariat_protected: "Không thể tắt Ban thư ký",
};

export class UnitError extends Error {
  constructor(public readonly code: UnitErrorCode) {
    super(MESSAGES[code]);
    this.name = "UnitError";
  }
}

const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === UNIQUE_VIOLATION || err?.cause?.code === UNIQUE_VIOLATION;
};

function cleanName(name: string): string {
  const n = name.trim();
  if (!n) throw new UnitError("invalid_name");
  return n;
}

export async function listUnits(db: DbLike = defaultDb): Promise<Unit[]> {
  return db.select().from(units).orderBy(asc(units.name));
}

export async function createUnit(name: string, db: DbLike = defaultDb): Promise<Unit> {
  const clean = cleanName(name);
  try {
    const [row] = await db.insert(units).values({ name: clean }).returning();
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) throw new UnitError("duplicate_name");
    throw e;
  }
}

/** Đổi tên và/hoặc bật/tắt. Ban thư ký (is_secretariat) không bao giờ bị tắt. */
export async function updateUnit(id: number, patch: UnitPatch, db: DbLike = defaultDb): Promise<Unit> {
  const set: Partial<Pick<Unit, "name" | "active">> = {};
  if (patch.name !== undefined) set.name = cleanName(patch.name);
  if (patch.active !== undefined) set.active = patch.active;

  const [current] = await db.select().from(units).where(eq(units.id, id));
  if (!current) throw new UnitError("not_found");
  if (current.isSecretariat && set.active === false) throw new UnitError("secretariat_protected");
  if (Object.keys(set).length === 0) return current;

  try {
    const [row] = await db.update(units).set(set).where(eq(units.id, id)).returning();
    if (!row) throw new UnitError("not_found");
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) throw new UnitError("duplicate_name");
    throw e;
  }
}
