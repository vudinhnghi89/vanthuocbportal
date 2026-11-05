import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { dbSuiteMode } from "../db/require-db";

const ROOT = path.resolve(__dirname, "../..");
const BUNDLE = path.join(ROOT, "dist/migrate.js");
const mode = dbSuiteMode(process.env);

describe.skipIf(mode !== "run")("dist/migrate.js (bundle chạy trong container migrate)", () => {
  let admin: Pool;
  const dbs: string[] = [];
  let tmp: string;

  const urlFor = (name: string) => {
    const u = new URL(process.env.DATABASE_URL!);
    u.pathname = `/${name}`;
    return u.toString();
  };
  async function freshDb(): Promise<string> {
    const name = `vtp_m_${randomBytes(6).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${name}`);
    dbs.push(name);
    return urlFor(name);
  }
  function runBundle(env: Record<string, string>) {
    const r = spawnSync("node", [BUNDLE], {
      cwd: tmp, // không phải thư mục dự án: chứng minh không phụ thuộc process.cwd()
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: tmp, ...env } as unknown as NodeJS.ProcessEnv,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }
  async function query<T extends object>(url: string, sql: string): Promise<T[]> {
    const p = new Pool({ connectionString: url });
    p.on("error", () => {});
    try {
      return (await p.query(sql)).rows as T[];
    } finally {
      await p.end();
    }
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vtp-migrate-"));
    admin = new Pool({ connectionString: process.env.DATABASE_URL });
    admin.on("error", () => {});
    const b = spawnSync("npm", ["run", "build:migrate"], { cwd: ROOT, encoding: "utf8" });
    expect(b.status, b.stdout + b.stderr).toBe(0);
  }, 120_000);

  afterAll(async () => {
    for (const n of dbs) await admin.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const good = { ADMIN_USERNAME: "quantri", ADMIN_PASSWORD: "S3cret-pass-123" };

  it("DB trống: tạo bảng, Ban thư ký và admin; chạy lần hai là no-op, mã thoát 0", async () => {
    const url = await freshDb();
    const env = { DATABASE_URL: url, MIGRATIONS_DIR: path.join(ROOT, "drizzle"), ...good };
    const first = runBundle(env);
    expect(first.status, first.out).toBe(0);
    expect(first.out).not.toContain(good.ADMIN_PASSWORD);
    const users = await query<{ username: string; role: string }>(url, "select username, role from users");
    expect(users).toEqual([{ username: "quantri", role: "admin" }]);
    const units = await query<{ name: string; is_secretariat: boolean }>(url, "select name, is_secretariat from units");
    expect(units).toEqual([{ name: "Ban thư ký", is_secretariat: true }]);

    const second = runBundle(env);
    expect(second.status, second.out).toBe(0);
    expect(await query(url, "select 1 from users")).toHaveLength(1);
    expect(await query(url, "select 1 from units")).toHaveLength(1);
  });

  it("mặc định tìm drizzle/ cạnh thư mục bundle (không dùng process.cwd())", async () => {
    // Bố cục như image: <app>/dist/migrate.js + <app>/drizzle
    const app = fs.mkdtempSync(path.join(tmp, "app-"));
    fs.mkdirSync(path.join(app, "dist"));
    fs.copyFileSync(BUNDLE, path.join(app, "dist/migrate.js"));
    fs.cpSync(path.join(ROOT, "drizzle"), path.join(app, "drizzle"), { recursive: true });
    // node_modules cho phần external (@node-rs/argon2)
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(app, "node_modules"));
    const url = await freshDb();
    const r = spawnSync("node", [path.join(app, "dist/migrate.js")], {
      cwd: tmp,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: tmp, DATABASE_URL: url, ...good } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(await query(url, "select 1 from users")).toHaveLength(1);
  });

  it("ADMIN_PASSWORD 7 ký tự: thoát 1, không seed gì, không lộ mật khẩu", async () => {
    const url = await freshDb();
    const bad = "1234567";
    const r = runBundle({ DATABASE_URL: url, MIGRATIONS_DIR: path.join(ROOT, "drizzle"), ADMIN_USERNAME: "quantri", ADMIN_PASSWORD: bad });
    expect(r.status).toBe(1);
    expect(r.out).toContain("ADMIN_PASSWORD");
    expect(r.out).not.toContain(bad);
    expect(await query(url, "select 1 from users")).toHaveLength(0);
    expect(await query(url, "select 1 from units")).toHaveLength(0);
  });

  it("MIGRATIONS_DIR không tồn tại: lỗi rõ ràng, thoát 1", async () => {
    const url = await freshDb();
    const r = runBundle({ DATABASE_URL: url, MIGRATIONS_DIR: path.join(tmp, "khong-co"), ...good });
    expect(r.status).toBe(1);
    expect(r.out).toContain("khong-co");
    expect(r.out).toContain("migration");
  });
});
