import { eq } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/db/client";
import { users } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/password";

export type AuthUser = { id: number; username: string; role: "admin" | "user" };

// Băm giả để thời gian phản hồi của "user không tồn tại" gần giống "sai mật khẩu".
let dummyHash: Promise<string> | undefined;

export async function authorizeCredentials(
  username: string,
  password: string,
  db: Pick<Db, "select"> = defaultDb,
): Promise<AuthUser | null> {
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const hash = user?.passwordHash ?? (await (dummyHash ??= hashPassword("dummy-password")));
  const ok = await verifyPassword(hash, password);
  if (!user || !ok || !user.active) return null;
  return { id: user.id, username: user.username, role: user.role };
}
