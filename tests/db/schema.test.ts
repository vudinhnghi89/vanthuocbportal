import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "@/db/schema";
import { seed } from "@/db/seed";
import { verifyPassword } from "@/lib/password";
import { dbSuiteMode } from "./require-db";

const baseUrl = process.env.DATABASE_URL;
const mode = dbSuiteMode(process.env);
if (mode === "skip") console.warn("[schema.test] DATABASE_URL chưa đặt: bỏ qua test DB");

it.runIf(mode === "fail")("DATABASE_URL bắt buộc trong CI", () => {
  throw new Error("DATABASE_URL chưa đặt trong CI: test DB không thể chạy, không được bỏ qua âm thầm");
});

describe.skipIf(mode !== "run")("db schema, migration, seed", () => {
  const dbName = `vtp_t_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const env = { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "s3cret-pass" };

  beforeAll(async () => {
    admin = new Pool({ connectionString: baseUrl });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(baseUrl!);
    u.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: u.toString() });
    // DROP DATABASE ... WITH (FORCE) in afterAll may kill idle backends (57P01); ignore the pool error event.
    pool.on("error", () => {});
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("migrate trên DB sạch thành công và tạo đủ bảng", async () => {
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
    const { rows } = await pool.query(
      "select table_name from information_schema.tables where table_schema='public'",
    );
    const names = rows.map((r) => r.table_name);
    for (const t of [
      "users", "units", "rules", "rule_audit", "issuer_aliases", "documents",
      "document_events", "integration_settings", "settings_audit",
    ]) expect(names).toContain(t);
  });

  it("seed chạy 2 lần vẫn đúng 1 Ban thư ký và 1 admin", async () => {
    await seed(db, env);
    await seed(db, env);
    const units = await db.select().from(schema.units).where(eq(schema.units.isSecretariat, true));
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("Ban thư ký");
    const admins = await db.select().from(schema.users).where(eq(schema.users.role, "admin"));
    expect(admins).toHaveLength(1);
    expect(admins[0].username).toBe("admin");
    expect(admins[0].passwordHash).toMatch(/^\$argon2/);
    expect(await verifyPassword(admins[0].passwordHash, "s3cret-pass")).toBe(true);
    expect(await verifyPassword(admins[0].passwordHash, "wrong")).toBe(false);
  });

  it("users.username là unique", async () => {
    await expect(
      db.insert(schema.users).values({ username: "admin", passwordHash: "x", role: "user" }),
    ).rejects.toThrow();
  });

  it("chỉ một đơn vị is_secretariat (unique)", async () => {
    await expect(
      db.insert(schema.units).values({ name: "Khác", isSecretariat: true }),
    ).rejects.toThrow();
  });

  it("từ chối giá trị enum/check không hợp lệ", async () => {
    await expect(
      db.insert(schema.users).values({ username: "u2", passwordHash: "x", role: "root" as never }),
    ).rejects.toThrow();
    await expect(
      pool.query("insert into documents(filename,pdf_path,status) values('a','b','bogus')"),
    ).rejects.toThrow();
    await expect(
      pool.query("insert into integration_settings(key) values('other')"),
    ).rejects.toThrow();
  });

  it("issuer_aliases.alias là unique; documents mặc định status queued", async () => {
    await db.insert(schema.issuerAliases).values({ alias: "byt", canonicalIssuer: "bo y te" });
    await expect(
      db.insert(schema.issuerAliases).values({ alias: "byt", canonicalIssuer: "x" }),
    ).rejects.toThrow();
    const [d] = await db.insert(schema.documents).values({ filename: "a.pdf", pdfPath: "/data/pdf/x.pdf" }).returning();
    expect(d.status).toBe("queued");
    expect(d.needsManual).toBe(false);
  });
});
