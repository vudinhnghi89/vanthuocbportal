import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

import { createAlias, deleteAlias, listAliases, loadAliases } from "@/server/aliases";
import { GET, POST } from "@/app/api/admin/aliases/route";
import { DELETE } from "@/app/api/admin/aliases/[id]/route";

const mode = dbSuiteMode(process.env);
it.runIf(mode === "fail")("DATABASE_URL bắt buộc trong CI", () => {
  throw new Error("DATABASE_URL chưa đặt trong CI: test DB không thể chạy");
});

const session = (role: "admin" | "user") => ({
  user: { id: 1, username: "u", role, active: true },
  expires: "2099-01-01",
});

describe.skipIf(mode !== "run")("aliases", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
  });
  afterAll(async () => {
    await t?.cleanup();
  });
  beforeEach(async () => {
    authMock.mockReset();
    await t.db.delete(schema.issuerAliases);
  });

  describe("server functions", () => {
    it("create / list / delete / loadAliases", async () => {
      const a = await createAlias("  BYT ", " Bộ Y Tế ", undefined, t.db);
      expect(a).toMatchObject({ alias: "BYT", canonicalIssuer: "Bộ Y Tế", aliasNorm: "byt" });
      await createAlias("BGD", "Bộ Giáo dục", 1, t.db);
      expect((await listAliases(t.db)).map((x) => x.alias)).toEqual(["BGD", "BYT"]);
      expect(await loadAliases(t.db)).toEqual([
        { alias: "BGD", canonicalIssuer: "Bộ Giáo dục" },
        { alias: "BYT", canonicalIssuer: "Bộ Y Tế" },
      ]);
      await deleteAlias(a.id, t.db);
      expect(await listAliases(t.db)).toHaveLength(1);
      await expect(deleteAlias(a.id, t.db)).rejects.toMatchObject({ code: "not_found" });
    });

    it("trùng sau chuẩn hóa -> duplicate_alias", async () => {
      await createAlias("BYT", "Bộ Y Tế", undefined, t.db);
      await expect(createAlias("byt ", "Khác", undefined, t.db)).rejects.toMatchObject({ code: "duplicate_alias" });
    });

    it("validation: rỗng, quá dài, alias == canonical", async () => {
      await expect(createAlias("  ", "x", undefined, t.db)).rejects.toMatchObject({ code: "invalid_alias" });
      await expect(createAlias("x", " ", undefined, t.db)).rejects.toMatchObject({ code: "invalid_canonical" });
      await expect(createAlias("..", "x", undefined, t.db)).rejects.toMatchObject({ code: "invalid_alias" });
      await expect(createAlias("a".repeat(201), "x", undefined, t.db)).rejects.toMatchObject({ code: "too_long" });
      await expect(createAlias("x", "b".repeat(201), undefined, t.db)).rejects.toMatchObject({ code: "too_long" });
      await createAlias("a".repeat(200), "x", undefined, t.db);
      await expect(createAlias("Bộ Y Tế", "bo y te.", undefined, t.db)).rejects.toMatchObject({
        code: "same_as_canonical",
      });
    });

    it("ngăn chuỗi bí danh", async () => {
      await createAlias("BYT", "Bộ Y Tế", undefined, t.db);
      // alias mới trùng canonical của dòng hiện có
      await expect(createAlias("bo y te", "Bộ Sức khỏe", undefined, t.db)).rejects.toMatchObject({
        code: "alias_chain",
      });
      // canonical mới trùng alias hiện có
      await expect(createAlias("Y tế TW", "byt", undefined, t.db)).rejects.toMatchObject({ code: "alias_chain" });
      expect(await listAliases(t.db)).toHaveLength(1);
    });
  });

  describe("API", () => {
    const json = (method: string, body: unknown) =>
      new Request("http://x/api/admin/aliases", {
        method,
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    const del = (id: string) => DELETE(new Request("http://x", { method: "DELETE" }), ctx(id));

    it("401/403 trên mọi method", async () => {
      const a = await createAlias("BYT", "Bộ Y Tế", undefined, t.db);
      authMock.mockResolvedValue(null);
      expect((await GET()).status).toBe(401);
      expect((await POST(json("POST", { alias: "a", canonicalIssuer: "b" }))).status).toBe(401);
      expect((await del(String(a.id))).status).toBe(401);
      authMock.mockResolvedValue(session("user"));
      expect((await GET()).status).toBe(403);
      expect((await POST(json("POST", { alias: "a", canonicalIssuer: "b" }))).status).toBe(403);
      expect((await del(String(a.id))).status).toBe(403);
      expect(await listAliases(t.db)).toHaveLength(1);
    });

    it("admin: tạo/liệt kê/xóa và mã lỗi", async () => {
      authMock.mockResolvedValue(session("admin"));
      const r = await POST(json("POST", { alias: "BYT", canonicalIssuer: "Bộ Y Tế" }));
      expect(r.status).toBe(201);
      const row = await r.json();
      expect(row).toMatchObject({ alias: "BYT", canonicalIssuer: "Bộ Y Tế" });
      expect((await POST(json("POST", { alias: "byt ", canonicalIssuer: "Z" }))).status).toBe(409);
      expect((await POST(json("POST", { alias: "bo y te", canonicalIssuer: "Z" }))).status).toBe(409);
      expect((await POST(json("POST", { alias: "Q", canonicalIssuer: "q." }))).status).toBe(400);
      expect((await POST(json("POST", { alias: "", canonicalIssuer: "Z" }))).status).toBe(400);
      expect((await (await GET()).json()).map((x: { alias: string }) => x.alias)).toEqual(["BYT"]);
      expect((await del(String(row.id))).status).toBe(204);
      expect((await del(String(row.id))).status).toBe(404);
    });

    it("id không hợp lệ -> 400", async () => {
      authMock.mockResolvedValue(session("admin"));
      for (const id of ["abc", "-1", "1.5", "1e3", "", " 1", "2147483648", "99999999999999999999999", "0x10"]) {
        expect((await del(id)).status, id).toBe(400);
      }
      expect((await del("2147483647")).status).toBe(404);
    });

    it("body xấu không bao giờ 500", async () => {
      authMock.mockResolvedValue(session("admin"));
      for (const body of ["not json", "null", "[]", "42", "{}", { alias: 1, canonicalIssuer: "x" }, { alias: "x" }, { alias: null, canonicalIssuer: {} }]) {
        expect((await POST(json("POST", body))).status, JSON.stringify(body)).toBe(400);
      }
      expect((await POST(json("POST", { alias: "a\u0000b", canonicalIssuer: "x" }))).status).toBeLessThan(500);
    });
  });
});
