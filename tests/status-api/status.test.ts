import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { Client, type Pool } from "pg";
import * as schema from "@/db/schema";
import { DOC_EVENTS_CHANNEL, type Status } from "@/server/status";
import { STATUS_LABELS } from "@/lib/status";
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

import { PATCH } from "@/app/api/documents/[id]/status/route";

const mode = dbSuiteMode(process.env);
const session = (id = 7) => ({ user: { id, username: "u", role: "user", active: true }, expires: "2099-01-01" });
const call = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/documents/${id}/status`, {
      method: "PATCH",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

describe.skipIf(mode !== "run")("PATCH /api/documents/[id]/status", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
    await t.db.insert(schema.users).values({ id: 7, username: "u7", passwordHash: "x", role: "user" });
  }, 30_000);
  afterAll(async () => {
    await t?.cleanup();
  }, 30_000);
  beforeEach(async () => {
    authMock.mockReset();
    authMock.mockResolvedValue(session());
    await t.db.delete(schema.documents);
  });

  const mk = async (status: Status, needsManual = false) =>
    (
      await t.db
        .insert(schema.documents)
        .values({ filename: "a.pdf", pdfPath: "/a.pdf", status, needsManual })
        .returning()
    )[0].id;
  const get = async (id: string) => (await t.db.select().from(schema.documents).where(eq(schema.documents.id, id)))[0];
  const events = (id: string) =>
    t.db.select().from(schema.documentEvents).where(eq(schema.documentEvents.documentId, id)).orderBy(asc(schema.documentEvents.id));

  it.each([
    ["classified", "unit_processing"],
    ["unit_processing", "done"],
  ] as const)("%s -> %s: 200 changed, one event with actor and note", async (from, to) => {
    const id = await mk(from);
    const res = await call(id, { to, from });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, status: to, changed: true });
    expect((await get(id)).status).toBe(to);
    expect((await events(id)).map((e) => [e.fromStatus, e.toStatus, e.actorId, e.note])).toEqual([
      [from, to, 7, "Cập nhật thủ công"],
    ]);
  });

  it("works without `from`", async () => {
    const id = await mk("classified");
    expect((await call(id, { to: "unit_processing" })).status).toBe(200);
  });

  it.each(["unit_processing", "done"] as const)("same status (%s) -> 200 changed:false, no event", async (st) => {
    const id = await mk(st);
    const res = await call(id, { to: st, from: st });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, status: st, changed: false });
    expect(await events(id)).toHaveLength(0);
  });

  it.each([
    ["queued", "done"],
    ["done", "unit_processing"],
    ["classified", "done"],
    ["failed", "done"],
    ["ocr_processing", "unit_processing"],
    ["rule_checking", "unit_processing"],
    ["failed", "unit_processing"],
  ] as const)("illegal %s -> %s: 409 naming current status, unchanged", async (from, to) => {
    const id = await mk(from);
    const res = await call(id, { to });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toContain(STATUS_LABELS[from]);
    expect((await get(id)).status).toBe(from);
    expect(await events(id)).toHaveLength(0);
  });

  it.each([{ to: "queued" }, { to: "classified" }, { to: "failed" }, { to: "bogus" }, {}, { to: 5 }, null, [], "not json"])(
    "invalid body %j -> 400",
    async (body) => {
      const id = await mk("classified");
      const res = await call(id, body === "not json" ? "{oops" : body);
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
      expect((await get(id)).status).toBe("classified");
    },
  );

  it("invalid `from` value -> 400", async () => {
    const id = await mk("classified");
    expect((await call(id, { to: "unit_processing", from: "bogus" })).status).toBe(400);
  });

  it("`from` mismatch -> 409 and nothing changed", async () => {
    const id = await mk("classified");
    const res = await call(id, { to: "unit_processing", from: "unit_processing" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Trạng thái đã thay đổi, vui lòng tải lại");
    expect((await get(id)).status).toBe("classified");
    expect(await events(id)).toHaveLength(0);
  });

  it("needs_manual -> 409 and nothing changed", async () => {
    const id = await mk("classified", true);
    const res = await call(id, { to: "unit_processing", from: "classified" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Cần phân loại thủ công trước khi chuyển đơn vị xử lý");
    expect((await get(id)).status).toBe("classified");
    expect(await events(id)).toHaveLength(0);
  });

  it.each(["queued", "ocr_processing", "rule_checking", "failed", "done"] as const)(
    "needs_manual on %s: 409 names the current status, not the needs-manual message",
    async (st) => {
      const id = await mk(st, true);
      for (const to of ["unit_processing", "done"] as const) {
        if (st === to) continue;
        const res = await call(id, { to });
        expect(res.status).toBe(409);
        const { error } = await res.json();
        expect(error).toContain(STATUS_LABELS[st]);
        expect(error).not.toContain("Cần phân loại thủ công");
      }
      expect((await get(id)).status).toBe(st);
      expect(await events(id)).toHaveLength(0);
    },
  );

  it("unit_processing + needs_manual -> done succeeds", async () => {
    const id = await mk("unit_processing", true);
    const res = await call(id, { to: "done", from: "unit_processing" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, status: "done", changed: true });
    expect(await events(id)).toHaveLength(1);
  });

  it("unit_processing + needs_manual -> unit_processing is a no-op 200", async () => {
    const id = await mk("unit_processing", true);
    const res = await call(id, { to: "unit_processing" });
    expect(await res.json()).toEqual({ id, status: "unit_processing", changed: false });
  });

  it("classified + needs_manual -> done: edge error naming current status", async () => {
    const id = await mk("classified", true);
    const res = await call(id, { to: "done" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain(STATUS_LABELS.classified);
  });

  it("stale `from` with the target status already reached -> 200 changed:false (documented ordering)", async () => {
    const id = await mk("unit_processing");
    const res = await call(id, { to: "unit_processing", from: "classified" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, status: "unit_processing", changed: false });
    expect(await events(id)).toHaveLength(0);
  });

  it("unknown id 404, bad uuid 400, unauthenticated 401", async () => {
    expect((await call("00000000-0000-4000-8000-000000000000", { to: "done" })).status).toBe(404);
    expect((await call("123", { to: "done" })).status).toBe(400);
    const id = await mk("classified");
    authMock.mockResolvedValue(null);
    expect((await call(id, { to: "unit_processing" })).status).toBe(401);
    expect((await get(id)).status).toBe("classified");
  });

  it("response never leaks other fields", async () => {
    const id = await mk("classified");
    const res = await call(id, { to: "unit_processing" });
    expect(Object.keys(await res.json()).sort()).toEqual(["changed", "id", "status"]);
  });

  it("concurrent identical requests -> exactly one event", async () => {
    const id = await mk("classified");
    const rs = await Promise.all([1, 2, 3].map(() => call(id, { to: "unit_processing" })));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    const bodies = await Promise.all(rs.map((r) => r.json()));
    expect(bodies.filter((b) => b.changed)).toHaveLength(1);
    expect(await events(id)).toHaveLength(1);
  });

  describe("pg_notify", () => {
    let listener: Client;
    const got: string[] = [];
    beforeAll(async () => {
      const pool = t.db.$client as Pool;
      listener = new Client({ connectionString: (pool.options as { connectionString: string }).connectionString });
      await listener.connect();
      listener.on("notification", (m) => got.push(m.payload ?? ""));
      await listener.query(`LISTEN ${DOC_EVENTS_CHANNEL}`);
    });
    afterAll(async () => {
      await listener?.end();
    });

    it("emits once for a real change, nothing for no-op", async () => {
      const id = await mk("classified");
      got.length = 0;
      await call(id, { to: "unit_processing" });
      await call(id, { to: "unit_processing" });
      await listener.query("select 1");
      expect(got.map((p) => JSON.parse(p))).toEqual([{ documentId: id, from: "classified", to: "unit_processing" }]);
    });
  });
});
