import { eq } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/db/client";
import { users } from "@/db/schema";

export type SessionUser = { id: number; username: string; role: "admin" | "user"; active: boolean };

/** Đọc lại role/active từ DB để đổi quyền hoặc khóa tài khoản có hiệu lực ngay. */
export async function buildSessionUser(
  token: Record<string, unknown>,
  db: Pick<Db, "select"> = defaultDb,
): Promise<SessionUser> {
  const [row] = await db
    .select({ role: users.role, active: users.active })
    .from(users)
    .where(eq(users.id, token.uid as number))
    .limit(1);
  return {
    id: token.uid as number,
    username: token.username as string,
    role: row?.role ?? (token.role as "admin" | "user"),
    active: row?.active ?? false,
  };
}
