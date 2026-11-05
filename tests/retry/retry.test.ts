import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Status } from "@/server/status";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";

const authMock = vi.fn();
vi.mock("@/auth/config", () => ({ auth: () => authMock() }));
const holder = vi.hoisted(() => ({ db: undefined as unknown, enqueue: "real" as "real" | "null" | "throw" }));
vi.mock("@/db/client", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/worker/queue", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/worker/queue")>();
  return {
    ...orig,
    enqueueOcr: (id: string) => {
      if (holder.enqueue === "throw") return Promise.reject(new Error("secret internal: connection refused 10.0.0.5"));
      if (holder.enqueue === "null") return Promise.resolve(null);
      return orig.enqueueOcr(id);
    },
  };
});

import { POST } from "@/app/api/documents/[id]/retry/route";
import { stopBoss } from "@/worker/queue";

const mode = dbSuiteMode(process.env);
const session = (id = 7, role = "user") => ({ user: { id, username: "u", role, active: true }, expires: "2099-01-01" });
const call = (id: string) =>
  POST(new Request(`http://localhost/api/documents/${id}/retry`, { method: "POST" }), { params: Promise.resolve({ id }) });

describe.skipIf(mode !== "run")("POST /api/documents/[id]/retry", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let prevDb: string | undefined;

  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
    prevDb = process.env.DATABASE_URL;
    process.env.DATABASE_URL = t.url;
    await t.db.insert(schema.users).values({ id: 7, username: "u7", passwordHash: "x", role: "user" });
  }, 30_000);
  afterAll(async () => {
    try {
      await stopBoss(2000);
    } finally {
      process.env.DATABASE_URL = prevDb;
      await t?.cleanup();
    }
  }, 30_000);
  beforeEach(async () => {
    authMock.mockReset();
    authMock.mockResolvedValue(session());
    holder.enqueue = "real";
    await t.db.delete(schema.documents);
    await t.db.execute(sql`delete from pgboss.job`).catch(() => {});
  });

  const mk = async (status: Status = "failed") =>
    (
      await t.db
        .insert(schema.documents)
        .values({ filename: "a.pdf", pdfPath: "/a.pdf", status, error: status === "failed" ? "lỗi cũ" : null })
        .returning()
    )[0].id;
  const get = async (id: string) => (await t.db.select().from(schema.documents).where(eq(schema.documents.id, id)))[0];

  it("failed -> 200 queued, error cleared, event with actor, job exists", async () => {
    const id = await mk();
    const res = await call(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "queued", alreadyQueued: false });
    const d = await get(id);
    expect(d.status).toBe("queued");
    expect(d.error).toBeNull();
    const ev = await t.db.select().from(schema.documentEvents).where(eq(schema.documentEvents.documentId, id)).orderBy(asc(schema.documentEvents.id));
    expect(ev.map((e) => [e.fromStatus, e.toStatus, e.actorId, e.note])).toEqual([["failed", "queued", 7, "Chạy lại"]]);
    const jobs = await t.db.execute(sql`select 1 from pgboss.job where name = 'ocr' and singleton_key = ${id}`);
    expect(jobs.rows).toHaveLength(1);
  });

  it.each(["queued", "ocr_processing", "rule_checking", "classified", "unit_processing", "done"] as const)(
    "%s -> 409 and unchanged",
    async (st) => {
      const id = await mk(st);
      const res = await call(id);
      expect(res.status).toBe(409);
      expect(typeof (await res.json()).error).toBe("string");
      expect((await get(id)).status).toBe(st);
    },
  );

  it("unauthenticated -> 401, no change", async () => {
    authMock.mockResolvedValue(null);
    const id = await mk();
    const res = await call(id);
    expect(res.status).toBe(401);
    expect((await get(id)).status).toBe("failed");
  });

  it("deactivated account -> 401", async () => {
    authMock.mockResolvedValue({ user: { id: 7, username: "u", role: "user", active: false }, expires: "2099-01-01" });
    expect((await call(await mk())).status).toBe(401);
  });

  it("a regular user is allowed (not admin-only)", async () => {
    expect((await call(await mk())).status).toBe(200);
  });

  it("non-uuid id -> 400", async () => {
    expect((await call("123")).status).toBe(400);
    expect((await call("not-a-uuid")).status).toBe(400);
  });

  it("unknown id -> 404", async () => {
    expect((await call("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("enqueue returns null -> 200 alreadyQueued", async () => {
    holder.enqueue = "null";
    const id = await mk();
    const res = await call(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "queued", alreadyQueued: true });
    expect((await get(id)).status).toBe("queued");
  });

  it("enqueue throws -> 503 generic message, document stays queued", async () => {
    holder.enqueue = "throw";
    const id = await mk();
    const res = await call(id);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain("10.0.0.5");
    expect(text).not.toContain("secret");
    expect((await get(id)).status).toBe("queued");
  });
});
