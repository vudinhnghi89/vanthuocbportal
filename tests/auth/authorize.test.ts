import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { authorizeCredentials } from "@/auth/authorize";
import { dbSuiteMode } from "../db/require-db";

const baseUrl = process.env.DATABASE_URL;
const mode = dbSuiteMode(process.env);
if (mode === "skip") console.warn("[authorize.test] DATABASE_URL chưa đặt: bỏ qua test DB");

it.runIf(mode === "fail")("DATABASE_URL bắt buộc trong CI", () => {
  throw new Error("DATABASE_URL chưa đặt trong CI: test DB không thể chạy");
});

describe.skipIf(mode !== "run")("authorizeCredentials", () => {
  const dbName = `vtp_t_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: baseUrl });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(baseUrl!);
    u.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: u.toString() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
    await db.insert(schema.users).values([
      { username: "ad", passwordHash: await hashPassword("right-pass"), role: "admin" },
      { username: "off", passwordHash: await hashPassword("right-pass"), role: "user", active: false },
    ]);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("đúng mật khẩu -> trả id, username, role", async () => {
    const r = await authorizeCredentials("ad", "right-pass", db);
    expect(r).toMatchObject({ username: "ad", role: "admin" });
    expect(typeof r?.id).toBe("number");
    expect(r).not.toHaveProperty("passwordHash");
  });

  it("sai mật khẩu -> null (401)", async () => {
    expect(await authorizeCredentials("ad", "wrong", db)).toBeNull();
  });

  it("user không tồn tại -> null", async () => {
    expect(await authorizeCredentials("ghost", "right-pass", db)).toBeNull();
  });

  it("user bị khóa -> null dù đúng mật khẩu", async () => {
    expect(await authorizeCredentials("off", "right-pass", db)).toBeNull();
  });
});
