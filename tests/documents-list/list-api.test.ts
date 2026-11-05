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

import { GET } from "@/app/api/documents/route";
import { GET as GET_UNITS } from "@/app/api/units/route";

const mode = dbSuiteMode(process.env);
const session = { user: { id: 1, username: "lan", role: "user", active: true }, expires: "2099-01-01" };
const get = (qs = "") => GET(new Request(`http://localhost/api/documents${qs ? `?${qs}` : ""}`));

type Item = Record<string, unknown> & { id: string; filename: string };
async function list(qs = ""): Promise<{ items: Item[]; total: number; page: number; pageSize: number }> {
  const res = await get(qs);
  expect(res.status).toBe(200);
  return res.json();
}
const names = (r: { items: Item[] }) => r.items.map((i) => i.filename);

describe.skipIf(mode !== "run")("GET /api/documents", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let uA: number, uB: number, uC: number;

  const doc = async (v: Partial<typeof schema.documents.$inferInsert> & { filename: string }) => {
    const [r] = await t.db
      .insert(schema.documents)
      .values({ pdfPath: "/secret/path.pdf", mdPath: "/secret/path.md", extracted: { secret: 1 }, uploadedBy: 1, ...v })
      .returning();
    return r;
  };

  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
    await t.db.insert(schema.users).values({ id: 1, username: "lan", passwordHash: "x" });
    const us = await t.db
      .insert(schema.units)
      .values([{ name: "A" }, { name: "B" }, { name: "C" }, { name: "Z off", active: false }, { name: "Ban thư ký", isSecretariat: true }])
      .returning();
    [uA, uB, uC] = us.map((u) => u.id);
  });
  afterAll(async () => {
    await t?.cleanup();
  });
  beforeEach(async () => {
    authMock.mockReset();
    authMock.mockResolvedValue(session);
    await t.db.delete(schema.documents);
  });

  it("401 when unauthenticated, for both endpoints", async () => {
    authMock.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect((await GET_UNITS()).status).toBe(401);
  });

  it("returns shape with defaults and never leaks path/extracted fields", async () => {
    const d = await doc({ filename: "a.pdf", mainUnitId: uA, infoUnitId: uB, matchMethod: "single", needsManual: true });
    const r = await list();
    expect(r).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    const item = r.items[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        "createdAt", "error", "filename", "id", "infoUnit", "mainUnit", "matchMethod", "matchedRuleId",
        "needsManual", "status", "updatedAt", "uploadedBy",
      ].sort(),
    );
    expect(item).toMatchObject({
      id: d.id, filename: "a.pdf", status: "queued", error: null, needsManual: true, matchMethod: "single",
      matchedRuleId: null, mainUnit: { id: uA, name: "A" }, infoUnit: { id: uB, name: "B" }, uploadedBy: "lan",
    });
    expect(new Date(item.createdAt as string).toISOString()).toBe(item.createdAt);
    expect(JSON.stringify(r)).not.toMatch(/secret/);
  });

  it("null units / uploader", async () => {
    await doc({ filename: "n.pdf", uploadedBy: null });
    const [i] = (await list()).items;
    expect(i).toMatchObject({ mainUnit: null, infoUnit: null, uploadedBy: null, matchMethod: null });
  });

  it("filters by status (single and comma list)", async () => {
    await doc({ filename: "q.pdf", status: "queued" });
    await doc({ filename: "f.pdf", status: "failed", error: "boom" });
    await doc({ filename: "d.pdf", status: "done" });
    expect(names(await list("status=failed"))).toEqual(["f.pdf"]);
    expect((await list("status=failed,done")).total).toBe(2);
    expect((await list("status=failed&status=done")).total).toBe(2);
    expect((await list("status=")).total).toBe(3);
  });

  it("unit filter matches main OR info", async () => {
    await doc({ filename: "m.pdf", mainUnitId: uA });
    await doc({ filename: "i.pdf", mainUnitId: uB, infoUnitId: uA });
    await doc({ filename: "x.pdf", mainUnitId: uB, infoUnitId: uC });
    expect((await list(`unit=${uA}`)).items.map((i) => i.filename).sort()).toEqual(["i.pdf", "m.pdf"]);
    expect(names(await list(`unit=${uC}`))).toEqual(["x.pdf"]);
  });

  it("needsManual", async () => {
    await doc({ filename: "n.pdf", needsManual: true });
    await doc({ filename: "o.pdf" });
    expect(names(await list("needsManual=true"))).toEqual(["n.pdf"]);
    expect((await list("needsManual=false")).total).toBe(2);
    expect((await get("needsManual=yes")).status).toBe(400);
  });

  it("date boundaries are Asia/Ho_Chi_Minh", async () => {
    await doc({ filename: "before.pdf", createdAt: new Date("2026-03-01T16:59:59Z") });
    await doc({ filename: "after.pdf", createdAt: new Date("2026-03-01T17:00:00Z") });
    await doc({ filename: "prev.pdf", createdAt: new Date("2026-02-28T16:59:59Z") });
    expect(names(await list("from=2026-03-01&to=2026-03-01"))).toEqual(["before.pdf"]);
    expect(names(await list("from=2026-03-02&to=2026-03-02"))).toEqual(["after.pdf"]);
    expect(names(await list("from=2026-03-02")).sort()).toEqual(["after.pdf"]);
    expect(names(await list("to=2026-03-01"))).toEqual(["before.pdf", "prev.pdf"]);
    expect((await list("from=2026-03-01&to=2026-03-02")).total).toBe(2);
  });

  it("q is a case-insensitive substring with literal %, _ and backslash", async () => {
    await doc({ filename: "Công văn 100%.pdf" });
    await doc({ filename: "Công văn 100x.pdf" });
    await doc({ filename: "a_b.pdf" });
    await doc({ filename: "aXb.pdf" });
    await doc({ filename: "c\\d.pdf" });
    await doc({ filename: "cd.pdf" });
    expect(names(await list(`q=${encodeURIComponent("CÔNG VĂN")}`)).length).toBe(2);
    expect(names(await list(`q=${encodeURIComponent("100%")}`))).toEqual(["Công văn 100%.pdf"]);
    expect(names(await list("q=a_b"))).toEqual(["a_b.pdf"]);
    expect(names(await list(`q=${encodeURIComponent("c\\d")}`))).toEqual(["c\\d.pdf"]);
    expect((await list("q=%25")).total).toBe(1);
    expect((await list("q=")).total).toBe(6);
  });

  it("combines filters", async () => {
    await doc({ filename: "hit.pdf", status: "failed", mainUnitId: uA, needsManual: true, createdAt: new Date("2026-03-01T01:00:00Z") });
    await doc({ filename: "miss1.pdf", status: "done", mainUnitId: uA, needsManual: true, createdAt: new Date("2026-03-01T01:00:00Z") });
    await doc({ filename: "miss2.pdf", status: "failed", mainUnitId: uB, needsManual: true, createdAt: new Date("2026-03-01T01:00:00Z") });
    await doc({ filename: "miss3.pdf", status: "failed", mainUnitId: uA, needsManual: false, createdAt: new Date("2026-03-01T01:00:00Z") });
    await doc({ filename: "miss4.pdf", status: "failed", mainUnitId: uA, needsManual: true, createdAt: new Date("2026-04-01T01:00:00Z") });
    const r = await list(`status=failed&unit=${uA}&needsManual=true&from=2026-03-01&to=2026-03-31&q=HIT`);
    expect(names(r)).toEqual(["hit.pdf"]);
    expect(r.total).toBe(1);
  });

  it("paginates: page 2, partial last page, beyond end", async () => {
    for (let i = 0; i < 5; i++) await doc({ filename: `p${i}.pdf`, createdAt: new Date(Date.UTC(2026, 0, 1 + i)) });
    const p1 = await list("pageSize=2");
    expect(names(p1)).toEqual(["p4.pdf", "p3.pdf"]);
    expect(p1.total).toBe(5);
    expect(names(await list("pageSize=2&page=2"))).toEqual(["p2.pdf", "p1.pdf"]);
    const last = await list("pageSize=2&page=3");
    expect(names(last)).toEqual(["p0.pdf"]);
    const beyond = await list("pageSize=2&page=9");
    expect(beyond).toMatchObject({ items: [], total: 5, page: 9, pageSize: 2 });
  });

  it("orders by created_at desc then id desc (stable on ties)", async () => {
    const same = new Date("2026-05-05T00:00:00Z");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await doc({ filename: `t${i}.pdf`, createdAt: same })).id);
    const a = (await list()).items.map((i) => i.id);
    const b = (await list()).items.map((i) => i.id);
    expect(a).toEqual(b);
    expect(a).toEqual([...ids].sort().reverse());
  });

  it.each([
    "page=0", "page=-1", "page=1.5", "page=abc", "pageSize=101", "pageSize=0", "unit=abc", "unit=99999999999", "unit=0",
    "unit=-3", "unit=1e3", "status=bogus", "status=failed,bogus", "from=2026-03-02&to=2026-03-01", "from=2026-3-1",
    "from=2026-02-30", "to=notadate", "page=99999999999999999999",
  ])("400 with Vietnamese message for %s", async (qs) => {
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
  });

  it("GET /api/units returns only active units ordered by name", async () => {
    const res = await GET_UNITS();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((u: { name: string }) => u.name)).toEqual(["A", "B", "Ban thư ký", "C"]);
    expect(Object.keys(body[0]).sort()).toEqual(["id", "isSecretariat", "name"]);
    expect(body.find((u: { name: string }) => u.name === "Ban thư ký").isSecretariat).toBe(true);
  });
});
