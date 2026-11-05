import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { seed } from "@/db/seed";
import { authorizeCredentials } from "@/auth/authorize";
import { dbSuiteMode } from "./require-db";
import { createTestDb } from "./test-db";

const mode = dbSuiteMode(process.env);
const env = (o: Record<string, string> = {}) => ({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "password-ok", ...o });

describe.skipIf(mode !== "run")("seed: kiểm tra thông tin admin", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
  }, 30_000);
  afterAll(async () => {
    await t?.cleanup();
  });
  beforeEach(async () => {
    await t.db.delete(schema.users);
    await t.db.delete(schema.units);
  });
  const counts = async () => ({
    users: (await t.db.select().from(schema.users)).length,
    units: (await t.db.select().from(schema.units)).length,
  });

  it("mật khẩu >256 ký tự: ném lỗi tiếng Việt không lộ mật khẩu, không ghi gì (cả đơn vị)", async () => {
    const pw = "x".repeat(257);
    const err = await seed(t.db, env({ ADMIN_PASSWORD: pw })).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/ADMIN_PASSWORD/);
    expect(err.message).not.toContain(pw);
    expect(await counts()).toEqual({ users: 0, units: 0 });
  });

  it("mật khẩu 7 ký tự: ném lỗi, không ghi gì", async () => {
    await expect(seed(t.db, env({ ADMIN_PASSWORD: "1234567" }))).rejects.toThrow(/ADMIN_PASSWORD/);
    expect(await counts()).toEqual({ users: 0, units: 0 });
  });

  it("tên đăng nhập ngắn/dài quá: ném lỗi, không ghi gì", async () => {
    await expect(seed(t.db, env({ ADMIN_USERNAME: "ab" }))).rejects.toThrow(/ADMIN_USERNAME/);
    await expect(seed(t.db, env({ ADMIN_USERNAME: "a".repeat(51) }))).rejects.toThrow(/ADMIN_USERNAME/);
    expect(await counts()).toEqual({ users: 0, units: 0 });
  });

  it("đúng 256 ký tự: seed được và admin đăng nhập được; đúng 8 ký tự cũng được", async () => {
    const pw = "p".repeat(256);
    await seed(t.db, env({ ADMIN_PASSWORD: pw }));
    expect(await authorizeCredentials("admin", pw, t.db)).toMatchObject({ username: "admin", role: "admin" });
    await seed(t.db, env({ ADMIN_USERNAME: "admin8", ADMIN_PASSWORD: "12345678" }));
    expect(await authorizeCredentials("admin8", "12345678", t.db)).not.toBeNull();
  });

  it("admin đã tồn tại + env không hợp lệ: seed vẫn thành công, không đụng dòng cũ", async () => {
    await seed(t.db, env());
    const [before] = await t.db.select().from(schema.users).where(eq(schema.users.username, "admin"));
    await expect(seed(t.db, env({ ADMIN_PASSWORD: "x".repeat(300) }))).resolves.toBeUndefined();
    const [after] = await t.db.select().from(schema.users).where(eq(schema.users.username, "admin"));
    expect(after).toEqual(before);
  });

  it("CLI: thoát mã khác 0, thông báo không chứa mật khẩu", () => {
    const pw = "z".repeat(300);
    const r = spawnSync("npx", ["tsx", path.resolve(__dirname, "../../src/db/seed.ts")], {
      env: { ...process.env, DATABASE_URL: t.url, ADMIN_USERNAME: "admin", ADMIN_PASSWORD: pw },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/ADMIN_PASSWORD/);
    expect(r.stderr + r.stdout).not.toContain(pw);
  }, 60_000);
});
