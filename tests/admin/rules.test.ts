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

import { createRule, deleteRule, listRules, toggleRule, updateRule, RuleError, type RuleInput } from "@/server/rules";
import { GET, POST } from "@/app/api/admin/rules/route";
import { DELETE, PATCH } from "@/app/api/admin/rules/[id]/route";

const mode = dbSuiteMode(process.env);
it.runIf(mode === "fail")("DATABASE_URL bắt buộc trong CI", () => {
  throw new Error("DATABASE_URL chưa đặt trong CI: test DB không thể chạy");
});

const session = (role: "admin" | "user") => ({
  user: { id: 1, username: "u", role, active: true },
  expires: "2099-01-01",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(mode !== "run")("rules", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let mainId: number;
  let infoId: number;
  let offId: number;
  const input = (o: Partial<RuleInput> = {}): RuleInput => ({
    issuer: "Bộ Y tế",
    docType: "Công văn",
    title: "",
    summary: "",
    mainUnitId: mainId,
    infoUnitId: infoId,
    priority: 0,
    ...o,
  });

  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
  });
  afterAll(async () => {
    await t?.cleanup();
  });
  beforeEach(async () => {
    authMock.mockReset();
    await t.db.delete(schema.documents);
    await t.db.delete(schema.rules);
    await t.db.delete(schema.units);
    const us = await t.db
      .insert(schema.units)
      .values([{ name: "Phòng A" }, { name: "Phòng B" }, { name: "Phòng Tắt", active: false }])
      .returning();
    [mainId, infoId, offId] = us.map((u) => u.id);
  });

  describe("server functions", () => {
    it("createRule lưu và cắt khoảng trắng; infoUnitId có thể null", async () => {
      const r = await createRule(input({ issuer: "  Bộ Y tế ", docType: " Thông tư", infoUnitId: null }), 1, t.db);
      expect(r).toMatchObject({ issuer: "Bộ Y tế", docType: "Thông tư", infoUnitId: null, active: true, title: "" });
    });

    it("thiếu/rỗng issuer hoặc docType bị từ chối", async () => {
      await expect(createRule(input({ issuer: "  " }), 1, t.db)).rejects.toMatchObject({ code: "invalid_issuer" });
      await expect(createRule(input({ docType: "" }), 1, t.db)).rejects.toMatchObject({ code: "invalid_doc_type" });
      await expect(createRule({ ...input(), issuer: undefined } as never, 1, t.db)).rejects.toBeInstanceOf(RuleError);
      await expect(createRule({ ...input(), title: null } as never, 1, t.db)).rejects.toMatchObject({
        code: "invalid_title",
      });
      await expect(createRule(input({ priority: 1.5 }), 1, t.db)).rejects.toMatchObject({ code: "invalid_priority" });
    });

    it("đơn vị phải tồn tại và đang hoạt động", async () => {
      await expect(createRule(input({ mainUnitId: offId }), 1, t.db)).rejects.toMatchObject({ code: "invalid_unit" });
      await expect(createRule(input({ infoUnitId: 999999 }), 1, t.db)).rejects.toMatchObject({ code: "invalid_unit" });
      expect(await listRules({}, t.db)).toHaveLength(0);
    });

    it("updateRule sửa field và làm updated_at tăng; sai dữ liệu không đổi DB", async () => {
      const r = await createRule(input(), 1, t.db);
      await sleep(15);
      const res = await updateRule(r.id, { title: "Mới", priority: 5 }, 1, t.db);
      const u = res.rule;
      expect(res.changed).toBe(true);
      expect(res.before).toMatchObject({ title: "", priority: 0 });
      expect(res.before.updatedAt.getTime()).toBe(r.updatedAt.getTime());
      expect(u).toMatchObject({ title: "Mới", priority: 5, issuer: "Bộ Y tế" });
      expect(u.updatedAt.getTime()).toBeGreaterThan(r.updatedAt.getTime());
      await expect(updateRule(r.id, { issuer: " " }, 1, t.db)).rejects.toMatchObject({ code: "invalid_issuer" });
      await expect(updateRule(r.id, { mainUnitId: offId }, 1, t.db)).rejects.toMatchObject({ code: "invalid_unit" });
      await expect(updateRule(999999, { title: "x" }, 1, t.db)).rejects.toMatchObject({ code: "not_found" });
      const [row] = await t.db.select().from(schema.rules).where(eq(schema.rules.id, r.id));
      expect(row).toMatchObject({ issuer: "Bộ Y tế", mainUnitId: mainId });
    });

    it("toggleRule bật/tắt thật làm updated_at tăng và changed=true", async () => {
      const r = await createRule(input(), 1, t.db);
      await sleep(15);
      const off = await toggleRule(r.id, false, 1, t.db);
      expect(off.changed).toBe(true);
      expect(off.rule.active).toBe(false);
      expect(off.before.active).toBe(true);
      expect(off.rule.updatedAt.getTime()).toBeGreaterThan(r.updatedAt.getTime());
      await sleep(15);
      const on = await toggleRule(r.id, true, 1, t.db);
      expect(on.changed).toBe(true);
      expect(on.rule.active).toBe(true);
      expect(on.rule.updatedAt.getTime()).toBeGreaterThan(off.rule.updatedAt.getTime());
      await expect(toggleRule(999999, true, 1, t.db)).rejects.toMatchObject({ code: "not_found" });
    });

    it("toggleRule no-op: không ghi, updated_at giữ nguyên, changed=false", async () => {
      const r = await createRule(input(), 1, t.db);
      await sleep(15);
      const same = await toggleRule(r.id, true, 1, t.db);
      expect(same.changed).toBe(false);
      expect(same.rule.updatedAt.getTime()).toBe(r.updatedAt.getTime());
      const [row] = await t.db.select().from(schema.rules).where(eq(schema.rules.id, r.id));
      expect(row.updatedAt.getTime()).toBe(r.updatedAt.getTime());
    });

    it("updateRule nhận active cùng field trong một lần cập nhật", async () => {
      const r = await createRule(input(), 1, t.db);
      const u = (await updateRule(r.id, { title: "T", active: false }, 1, t.db)).rule;
      expect(u).toMatchObject({ title: "T", active: false });
      await expect(updateRule(r.id, { title: "U", active: "x" as never }, 1, t.db)).rejects.toMatchObject({
        code: "invalid_active",
      });
      const [row] = await t.db.select().from(schema.rules).where(eq(schema.rules.id, r.id));
      expect(row.title).toBe("T");
    });

    it("updateRule no-op (cùng giá trị / chỉ active hiện tại): không ghi, changed=false", async () => {
      const r = await createRule(input({ title: "A", priority: 3 }), 1, t.db);
      await sleep(15);
      const same = await updateRule(r.id, { title: "A", priority: 3, infoUnitId: infoId }, 1, t.db);
      expect(same.changed).toBe(false);
      expect(same.rule).toEqual(r);
      const onlyActive = await updateRule(r.id, { active: true }, 1, t.db);
      expect(onlyActive.changed).toBe(false);
      const [row] = await t.db.select().from(schema.rules).where(eq(schema.rules.id, r.id));
      expect(row.updatedAt.getTime()).toBe(r.updatedAt.getTime());
      await sleep(15);
      const real = await updateRule(r.id, { title: "A", active: false }, 1, t.db);
      expect(real.changed).toBe(true);
      expect(real.before.active).toBe(true);
      expect(real.rule.active).toBe(false);
    });

    it("deleteRule trả dòng đã xóa; không tồn tại -> not_found", async () => {
      const r = await createRule(input({ title: "Xóa" }), 1, t.db);
      expect(await deleteRule(r.id, 1, t.db)).toEqual(r);
      expect(await listRules({}, t.db)).toHaveLength(0);
      await expect(deleteRule(r.id, 1, t.db)).rejects.toMatchObject({ code: "not_found" });
    });

    it("xóa rule đang được documents.matched_rule_id tham chiếu -> đặt NULL", async () => {
      const r = await createRule(input(), 1, t.db);
      const [d] = await t.db
        .insert(schema.documents)
        .values({ filename: "a.pdf", pdfPath: "/a.pdf", matchedRuleId: r.id })
        .returning();
      await deleteRule(r.id, 1, t.db);
      const [after] = await t.db.select().from(schema.documents).where(eq(schema.documents.id, d.id));
      expect(after.matchedRuleId).toBeNull();
    });

    it("listRules: tìm q (không phân biệt hoa thường, ký tự % được escape) và lọc active", async () => {
      await createRule(input({ issuer: "UBND", docType: "Quyết định", title: "Đất đai" }), 1, t.db);
      const b = await createRule(input({ issuer: "Sở Tài chính", docType: "Công văn", summary: "Giảm 50%" }), 1, t.db);
      await toggleRule(b.id, false, 1, t.db);
      expect(await listRules({ q: "ubnd" }, t.db)).toHaveLength(1);
      expect(await listRules({ q: "đất" }, t.db)).toHaveLength(1);
      expect(await listRules({ q: "50%" }, t.db)).toHaveLength(1);
      expect(await listRules({ q: "%" }, t.db)).toHaveLength(1);
      expect(await listRules({ active: false }, t.db)).toHaveLength(1);
      expect(await listRules({ active: true }, t.db)).toHaveLength(1);
      expect(await listRules({}, t.db)).toHaveLength(2);
    });
  });

  describe("API", () => {
    const json = (method: string, body: unknown, url = "http://x/api/admin/rules") =>
      new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });
    const body = (o: Record<string, unknown> = {}) => ({ ...input(), ...o });

    it("chưa đăng nhập 401, user 403 trên mọi method", async () => {
      const r = await createRule(input(), 1, t.db);
      authMock.mockResolvedValue(null);
      expect((await GET(new Request("http://x/api/admin/rules"))).status).toBe(401);
      expect((await POST(json("POST", body()))).status).toBe(401);
      authMock.mockResolvedValue(session("user"));
      expect((await GET(new Request("http://x/api/admin/rules"))).status).toBe(403);
      expect((await POST(json("POST", body()))).status).toBe(403);
      expect((await PATCH(json("PATCH", { active: false }), ctx(r.id))).status).toBe(403);
      expect((await DELETE(json("DELETE", {}), ctx(r.id))).status).toBe(403);
      expect(await listRules({}, t.db)).toHaveLength(1);
    });

    it("admin: POST thiếu issuer/docType -> 400; hợp lệ -> 201", async () => {
      authMock.mockResolvedValue(session("admin"));
      expect((await POST(json("POST", body({ issuer: "" })))).status).toBe(400);
      expect((await POST(json("POST", body({ docType: undefined })))).status).toBe(400);
      expect((await POST(json("POST", body({ mainUnitId: offId })))).status).toBe(400);
      expect((await POST(json("POST", [1]))).status).toBe(400);
      const ok = await POST(json("POST", body()));
      expect(ok.status).toBe(201);
      expect(await ok.json()).toMatchObject({ issuer: "Bộ Y tế", docType: "Công văn" });
    });

    it("admin: số ngoài miền int4 -> 400 (không phải 500)", async () => {
      authMock.mockResolvedValue(session("admin"));
      const r = await (await POST(json("POST", body()))).json();
      for (const bad of [{ priority: 3000000000 }, { priority: -2147483648 }, { mainUnitId: 3000000000 }, { infoUnitId: 3000000000 }, { mainUnitId: 0 }]) {
        expect((await POST(json("POST", body(bad)))).status).toBe(400);
        expect((await PATCH(json("PATCH", bad), ctx(r.id))).status).toBe(400);
      }
      expect((await POST(json("POST", body({ priority: 2147483647 })))).status).toBe(201);
      expect((await POST(json("POST", body({ priority: -2147483647 })))).status).toBe(201);
    });

    it("admin: PATCH nguyên tử — phần sau sai thì không đổi gì; kết hợp hợp lệ thì áp dụng", async () => {
      authMock.mockResolvedValue(session("admin"));
      const r = await (await POST(json("POST", body({ title: "Gốc" })))).json();
      expect((await PATCH(json("PATCH", { title: "Mới", mainUnitId: offId }), ctx(r.id))).status).toBe(400);
      expect((await PATCH(json("PATCH", { title: "Mới", active: "x" }), ctx(r.id))).status).toBe(400);
      const [row] = await t.db.select().from(schema.rules).where(eq(schema.rules.id, r.id));
      expect(row).toMatchObject({ title: "Gốc", active: true, mainUnitId: mainId });
      expect(row.updatedAt.getTime()).toBe(new Date(r.updatedAt).getTime());
      const ok = await PATCH(json("PATCH", { title: "Mới", active: false }), ctx(r.id));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ title: "Mới", active: false });
    });

    it("admin: GET lọc, PATCH sửa/bật tắt, DELETE", async () => {
      authMock.mockResolvedValue(session("admin"));
      const r = await (await POST(json("POST", body({ title: "Alpha" })))).json();
      await POST(json("POST", body({ issuer: "Khác", title: "Beta" })));
      const list = await (await GET(new Request("http://x/api/admin/rules?q=alpha"))).json();
      expect(list).toHaveLength(1);
      expect((await GET(new Request("http://x/api/admin/rules?active=maybe"))).status).toBe(400);

      const p = await PATCH(json("PATCH", { title: "Gamma", active: false }), ctx(r.id));
      expect(p.status).toBe(200);
      expect(await p.json()).toMatchObject({ title: "Gamma", active: false });
      expect((await (await GET(new Request("http://x/api/admin/rules?active=false"))).json())).toHaveLength(1);
      expect((await PATCH(json("PATCH", { issuer: "" }), ctx(r.id))).status).toBe(400);
      expect((await PATCH(json("PATCH", {}), ctx(r.id))).status).toBe(400);
      expect((await PATCH(json("PATCH", { active: "x" }), ctx(r.id))).status).toBe(400);
      expect((await PATCH(json("PATCH", { active: true }), ctx("abc"))).status).toBe(400);
      expect((await PATCH(json("PATCH", { active: true }), ctx(999999))).status).toBe(404);

      expect((await DELETE(json("DELETE", {}), ctx(r.id))).status).toBe(204);
      expect((await DELETE(json("DELETE", {}), ctx(r.id))).status).toBe(404);
    });
  });
});
