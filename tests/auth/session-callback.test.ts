import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "@/db/schema";
import { buildSessionUser } from "@/auth/callbacks";
import { dbSuiteMode } from "../db/require-db";

const baseUrl = process.env.DATABASE_URL;
const mode = dbSuiteMode(process.env);
if (mode === "skip") console.warn("[session-callback.test] DATABASE_URL chưa đặt: bỏ qua test DB");

it.runIf(mode === "fail")("DATABASE_URL bắt buộc trong CI", () => {
  throw new Error("DATABASE_URL chưa đặt trong CI: test DB không thể chạy");
});

describe.skipIf(mode !== "run")("buildSessionUser đọc lại role/active từ DB", () => {
  const dbName = `vtp_t_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let uid: number;

  beforeAll(async () => {
    admin = new Pool({ connectionString: baseUrl });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(baseUrl!);
    u.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: u.toString() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
    [{ id: uid }] = await db
      .insert(schema.users)
      .values({ username: "ad", passwordHash: "x", role: "admin" })
      .returning({ id: schema.users.id });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  const token = () => ({ uid, username: "ad", role: "admin" });

  it("phản ánh đổi role và khóa tài khoản ngay, dù token cũ vẫn ghi admin", async () => {
    expect(await buildSessionUser(token(), db)).toEqual({ id: uid, username: "ad", role: "admin", active: true });
    await db.update(schema.users).set({ role: "user" }).where(eq(schema.users.id, uid));
    expect((await buildSessionUser(token(), db)).role).toBe("user");
    await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, uid));
    expect((await buildSessionUser(token(), db)).active).toBe(false);
  });

  it("user đã bị xóa -> active=false", async () => {
    expect((await buildSessionUser({ uid: 999999, username: "gone", role: "admin" }, db)).active).toBe(false);
  });
});
