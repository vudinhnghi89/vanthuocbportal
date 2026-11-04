import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { hashPassword } from "../lib/password";

export const SECRETARIAT_NAME = "Ban thư ký";

type SeedEnv = Record<string, string | undefined>;

/** Idempotent: chạy nhiều lần vẫn chỉ có 1 Ban thư ký và 1 admin theo ADMIN_USERNAME. */
export async function seed(db: NodePgDatabase<typeof schema>, env: SeedEnv) {
  const { ADMIN_USERNAME: username, ADMIN_PASSWORD: password } = env;
  if (!username || !password) throw new Error("ADMIN_USERNAME và ADMIN_PASSWORD là bắt buộc");

  await db
    .insert(schema.units)
    .values({ name: SECRETARIAT_NAME, isSecretariat: true })
    .onConflictDoNothing();

  const existing = await db.select({ id: schema.users.id }).from(schema.users)
    .where(eq(schema.users.username, username));
  if (existing.length === 0) {
    await db
      .insert(schema.users)
      .values({ username, passwordHash: await hashPassword(password), role: "admin" })
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
    console.error(e);
    process.exit(1);
  });
}
