import { sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/db/client";
import { users } from "@/db/schema";
import { MAX_PASSWORD_LENGTH, hashPassword, verifyPassword } from "@/lib/password";

export type AuthUser = { id: number; username: string; role: "admin" | "user" };

// Băm giả để thời gian phản hồi của "user không tồn tại" gần giống "sai mật khẩu".
let dummyHash: Promise<string> | undefined;

export async function authorizeCredentials(
  username: string,
  password: string,
  db: Pick<Db, "select"> = defaultDb,
): Promise<AuthUser | null> {
  // Quá dài: coi như sai thông tin, không truy vấn và không băm argon2.
  if (password.length > MAX_PASSWORD_LENGTH) return null;
  const [user] = await db.select().from(users).where(sql`lower(${users.username}) = lower(${username})`).limit(1);
  const hash = user?.passwordHash ?? (await (dummyHash ??= hashPassword("dummy-password")));
  const ok = await verifyPassword(hash, password);
  if (!user || !ok || !user.active) return null;
  return { id: user.id, username: user.username, role: user.role };
}
