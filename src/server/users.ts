import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import { USER_ROLES, users } from "@/db/schema";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, hashPassword } from "@/lib/password";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/db/schema";

export type UserRole = (typeof USER_ROLES)[number];
/** Người dùng công khai: không bao giờ có password_hash. */
export type PublicUser = { id: number; username: string; role: UserRole; active: boolean; createdAt: Date };
type DbLike = NodePgDatabase<typeof schema>;

export type UserErrorCode =
  | "invalid_username"
  | "invalid_password"
  | "invalid_role"
  | "duplicate_username"
  | "not_found"
  | "last_admin";

const MESSAGES: Record<UserErrorCode, string> = {
  invalid_username: "Tên đăng nhập phải từ 3 đến 50 ký tự",
  invalid_password: `Mật khẩu phải có từ ${MIN_PASSWORD_LENGTH} đến ${MAX_PASSWORD_LENGTH} ký tự`,
  invalid_role: "Vai trò phải là admin hoặc user",
  duplicate_username: "Tên đăng nhập đã tồn tại",
  not_found: "Không tìm thấy người dùng",
  last_admin: "Không thể tắt quản trị viên hoạt động cuối cùng",
};

export class UserError extends Error {
  constructor(public readonly code: UserErrorCode) {
    super(MESSAGES[code]);
    this.name = "UserError";
  }
}

const PUBLIC_COLUMNS = {
  id: users.id,
  username: users.username,
  role: users.role,
  active: users.active,
  createdAt: users.createdAt,
};

const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === UNIQUE_VIOLATION || err?.cause?.code === UNIQUE_VIOLATION;
};

function checkPassword(p: unknown): string {
  if (typeof p !== "string" || p.length < MIN_PASSWORD_LENGTH || p.length > MAX_PASSWORD_LENGTH) throw new UserError("invalid_password");
  return p;
}

export async function listUsers(db: DbLike = defaultDb): Promise<PublicUser[]> {
  return db.select(PUBLIC_COLUMNS).from(users).orderBy(asc(users.username));
}

export async function createUser(
  username: string,
  password: string,
  role: UserRole,
  db: DbLike = defaultDb,
): Promise<PublicUser> {
  const name = typeof username === "string" ? username.trim() : "";
  if (name.length < 3 || name.length > 50) throw new UserError("invalid_username");
  checkPassword(password);
  if (!USER_ROLES.includes(role)) throw new UserError("invalid_role");
  const passwordHash = await hashPassword(password);
  try {
    const [row] = await db.insert(users).values({ username: name, passwordHash, role }).returning(PUBLIC_COLUMNS);
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) throw new UserError("duplicate_username");
    throw e;
  }
}

/** Tắt người dùng không bao giờ để lại 0 admin hoạt động: khóa các dòng admin hoạt động trong cùng giao dịch. */
export async function setActive(id: number, active: boolean, db: DbLike = defaultDb): Promise<PublicUser> {
  return db.transaction(async (tx) => {
    if (!active) {
      const admins = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.active, true)))
        .orderBy(asc(users.id))
        .for("update");
      if (admins.length <= 1 && admins.some((a) => a.id === id)) throw new UserError("last_admin");
    }
    const [row] = await tx.update(users).set({ active }).where(eq(users.id, id)).returning(PUBLIC_COLUMNS);
    if (!row) throw new UserError("not_found");
    return row;
  });
}

export async function resetPassword(id: number, newPassword: string, db: DbLike = defaultDb): Promise<void> {
  checkPassword(newPassword);
  const passwordHash = await hashPassword(newPassword);
  const rows = await db.update(users).set({ passwordHash }).where(eq(users.id, id)).returning({ id: users.id });
  if (rows.length === 0) throw new UserError("not_found");
}
