import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";

const authMock = vi.fn();
vi.mock("@/auth/config", () => ({ auth: () => authMock() }));
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({
  get db() {
    return holder.db;
  },
}));

import { createUnit, listUnits, updateUnit, UnitError } from "@/server/units";
import { GET, POST } from "@/app/api/admin/units/route";
import { PATCH } from "@/app/api/admin/units/[id]/route";

const mode = dbSuiteMode(process.env);
it.runIf(mode === "fail")("DATABASE_URL bắt buộc trong CI", () => {
  throw new Error("DATABASE_URL chưa đặt trong CI: test DB không thể chạy");
});

const session = (role: "admin" | "user") => ({
  user: { id: 1, username: "u", role, active: true },
  expires: "2099-01-01",
});

describe.skipIf(mode !== "run")("units", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let secId: number;

  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
  });
  afterAll(async () => {
    await t?.cleanup();
  });
  beforeEach(async () => {
    authMock.mockReset();
    await t.db.delete(schema.rules);
    await t.db.delete(schema.units);
    const [s] = await t.db
      .insert(schema.units)
      .values({ name: "Ban thư ký", isSecretariat: true })
      .returning();
    secId = s.id;
  });

  describe("server functions", () => {
    it("createUnit rồi listUnits (sắp theo tên)", async () => {
      const u = await createUnit("Phòng B", t.db);
      expect(u).toMatchObject({ name: "Phòng B", active: true, isSecretariat: false });
      await createUnit("Phòng A", t.db);
      expect((await listUnits(t.db)).map((x) => x.name)).toEqual(["Ban thư ký", "Phòng A", "Phòng B"]);
    });

    it("createUnit cắt khoảng trắng; tên rỗng -> invalid_name; trùng -> duplicate_name", async () => {
      expect((await createUnit("  Phòng C  ", t.db)).name).toBe("Phòng C");
      await expect(createUnit("   ", t.db)).rejects.toMatchObject({ code: "invalid_name" });
      await expect(createUnit("Phòng C", t.db)).rejects.toMatchObject({ code: "duplicate_name" });
    });

    it("updateUnit đổi tên và bật/tắt", async () => {
      const u = await createUnit("Phòng D", t.db);
      expect(await updateUnit(u.id, { name: "Phòng D2" }, t.db)).toMatchObject({ name: "Phòng D2", active: true });
      expect(await updateUnit(u.id, { active: false }, t.db)).toMatchObject({ active: false });
      expect(await updateUnit(u.id, { active: true }, t.db)).toMatchObject({ active: true });
    });

    it("updateUnit: không tồn tại -> not_found; tên trùng -> duplicate_name", async () => {
      await expect(updateUnit(999999, { name: "x" }, t.db)).rejects.toMatchObject({ code: "not_found" });
      const u = await createUnit("Phòng E", t.db);
      await expect(updateUnit(u.id, { name: "Ban thư ký" }, t.db)).rejects.toMatchObject({
        code: "duplicate_name",
      });
    });

    it("tắt Ban thư ký bị từ chối và không đổi DB", async () => {
      const p = updateUnit(secId, { active: false }, t.db);
      await expect(p).rejects.toBeInstanceOf(UnitError);
      await expect(p).rejects.toMatchObject({ code: "secretariat_protected" });
      const [row] = await t.db.select().from(schema.units).where(eq(schema.units.id, secId));
      expect(row.active).toBe(true);
    });

    it("Ban thư ký vẫn đổi tên được, và active:true là hợp lệ", async () => {
      expect(await updateUnit(secId, { name: "Ban Thư ký VP", active: true }, t.db)).toMatchObject({
        name: "Ban Thư ký VP",
        isSecretariat: true,
        active: true,
      });
    });
  });

  describe("tắt đơn vị còn được quy tắc hoạt động tham chiếu", () => {
    const mkRule = (main: number, info: number | null, active = true) =>
      t.db.insert(schema.rules).values({ issuer: "UBND", docType: "CV", title: "t", mainUnitId: main, infoUnitId: info, active });

    it("đơn vị chính hoặc đơn vị nhận tin của quy tắc ACTIVE -> in_use, nêu số quy tắc", async () => {
      const a = await createUnit("Phòng A", t.db);
      const b = await createUnit("Phòng B", t.db);
      await mkRule(a.id, b.id);
      await mkRule(a.id, null);
      const errA = await updateUnit(a.id, { active: false }, t.db).catch((e) => e);
      expect(errA).toBeInstanceOf(UnitError);
      expect(errA).toMatchObject({ code: "in_use", ruleCount: 2 });
      expect(errA.message).toMatch(/2 quy tắc/);
      await expect(updateUnit(b.id, { active: false }, t.db)).rejects.toMatchObject({ code: "in_use", ruleCount: 1 });
      const rows = await t.db.select().from(schema.units).where(eq(schema.units.id, a.id));
      expect(rows[0].active).toBe(true);
    });

    it("quy tắc đã tắt không chặn; đổi tên đơn vị đang dùng vẫn được", async () => {
      const a = await createUnit("Phòng A", t.db);
      await mkRule(a.id, null, false);
      expect(await updateUnit(a.id, { name: "Phòng A2" }, t.db)).toMatchObject({ name: "Phòng A2" });
      expect(await updateUnit(a.id, { active: false }, t.db)).toMatchObject({ active: false });
    });

    it("API: PATCH active:false -> 409 với thông điệp tiếng Việt có số quy tắc", async () => {
      authMock.mockResolvedValue(session("admin"));
      const a = await createUnit("Phòng A", t.db);
      await mkRule(a.id, null);
      const r = await PATCH(
        new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ active: false }) }),
        { params: Promise.resolve({ id: String(a.id) }) },
      );
      expect(r.status).toBe(409);
      const body = await r.json();
      expect(body).toMatchObject({ code: "in_use" });
      expect(body.error).toMatch(/1 quy tắc/);
    });
  });

  describe("API", () => {
    const json = (method: string, body: unknown, url = "http://x/api/admin/units") =>
      new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

    it("chưa đăng nhập 401, user 403 trên mọi method", async () => {
      authMock.mockResolvedValue(null);
      expect((await GET()).status).toBe(401);
      authMock.mockResolvedValue(session("user"));
      expect((await GET()).status).toBe(403);
      expect((await POST(json("POST", { name: "X" }))).status).toBe(403);
      expect((await PATCH(json("PATCH", { active: false }), ctx(secId))).status).toBe(403);
      expect(await listUnits(t.db)).toHaveLength(1);
    });

    it("admin: GET/POST/PATCH hoạt động", async () => {
      authMock.mockResolvedValue(session("admin"));
      const created = await POST(json("POST", { name: "Phòng F" }));
      expect(created.status).toBe(201);
      const unit = await created.json();
      expect(unit).toMatchObject({ name: "Phòng F", active: true });
      expect((await POST(json("POST", { name: "Phòng F" }))).status).toBe(409);
      expect((await POST(json("POST", { name: "" }))).status).toBe(400);
      const patched = await PATCH(json("PATCH", { name: "Phòng F2", active: false }), ctx(unit.id));
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({ name: "Phòng F2", active: false });
      const list = await (await GET()).json();
      expect(list.map((u: { name: string }) => u.name)).toContain("Phòng F2");
      expect((await PATCH(json("PATCH", {}), ctx(unit.id))).status).toBe(400);
      expect((await PATCH(json("PATCH", { active: "no" }), ctx(unit.id))).status).toBe(400);
      expect((await PATCH(json("PATCH", { active: true }), ctx("abc"))).status).toBe(400);
      expect((await PATCH(json("PATCH", { active: true }), ctx(999999))).status).toBe(404);
    });

    it("admin tắt Ban thư ký qua API -> 409 và vẫn active", async () => {
      authMock.mockResolvedValue(session("admin"));
      const r = await PATCH(json("PATCH", { active: false }), ctx(secId));
      expect(r.status).toBe(409);
      expect((await r.json()).error).toMatch(/Ban thư ký/);
      const [row] = await t.db.select().from(schema.units).where(eq(schema.units.id, secId));
      expect(row.active).toBe(true);
    });
  });
});
