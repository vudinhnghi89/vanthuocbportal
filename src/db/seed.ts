import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../lib/password";
import { ADMIN_PASSWORD_PLACEHOLDER, MAX_USERNAME_LENGTH, MIN_USERNAME_LENGTH, isValidPassword, isValidUsername } from "../lib/credentials";

export const SECRETARIAT_NAME = "Ban thư ký";

type SeedEnv = Record<string, string | undefined>;

/** Idempotent: chạy nhiều lần vẫn chỉ có 1 Ban thư ký và 1 admin theo ADMIN_USERNAME. */
export async function seed(db: NodePgDatabase<typeof schema>, env: SeedEnv) {
  const { ADMIN_USERNAME: username, ADMIN_PASSWORD: password } = env;
  if (!username || !password) throw new Error("ADMIN_USERNAME và ADMIN_PASSWORD là bắt buộc");

  const name = username.trim();
  const existing = await db.select({ id: schema.users.id }).from(schema.users)
    .where(eq(schema.users.username, name));
  const createAdmin = existing.length === 0;
  // Chỉ kiểm tra khi sắp tạo admin mới, và trước khi ghi bất kỳ dòng nào (seed nguyên tử).
  // Không đưa mật khẩu vào thông báo lỗi.
  if (createAdmin) {
    if (!isValidUsername(name)) {
      throw new Error(`ADMIN_USERNAME phải có từ ${MIN_USERNAME_LENGTH} đến ${MAX_USERNAME_LENGTH} ký tự`);
    }
    if (password === ADMIN_PASSWORD_PLACEHOLDER) {
      throw new Error("ADMIN_PASSWORD đang là giá trị mẫu — hãy đặt mật khẩu riêng");
    }
    if (!isValidPassword(password)) {
      throw new Error(`ADMIN_PASSWORD phải có từ ${MIN_PASSWORD_LENGTH} đến ${MAX_PASSWORD_LENGTH} ký tự`);
    }
  }

  await db
    .insert(schema.units)
    .values({ name: SECRETARIAT_NAME, isSecretariat: true })
    .onConflictDoNothing();

  if (createAdmin) {
    await db
      .insert(schema.users)
      .values({ username: name, passwordHash: await hashPassword(password), role: "admin" })
      .onConflictDoNothing();
  }
}

if (process.argv[1] && /seed\.[cm]?[jt]s$/.test(process.argv[1])) {
  (async () => {
    const { createDb } = await import("./client");
    const db = createDb(process.env.DATABASE_URL ?? "");
    try {
      await seed(db, process.env);
      console.log("seed OK");
    } finally {
      await db.pool.end();
    }
  })().catch((e) => {
    console.error(e instanceof Error ? e.message : "seed thất bại");
    process.exit(1);
  });
}
