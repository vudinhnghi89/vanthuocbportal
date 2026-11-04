import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Client, type Pool } from "pg";
import * as schema from "@/db/schema";
import { dbSuiteMode } from "./db/require-db";
import { createTestDb } from "./db/test-db";
import {
  ALLOWED_TRANSITIONS,
  DOC_EVENTS_CHANNEL,
  DocumentNotFoundError,
  InvalidTransitionError,
  STATUSES,
  STATUS_LABELS,
  transition,
  type Status,
} from "@/server/status";

const mode = dbSuiteMode(process.env);
it.runIf(mode === "fail")("DATABASE_URL bắt buộc trong CI", () => {
  throw new Error("DATABASE_URL chưa đặt trong CI: test DB không thể chạy");
});

const VALID: Array<[Status, Status]> = [
  ["queued", "ocr_processing"],
  ["ocr_processing", "rule_checking"],
  ["ocr_processing", "failed"],
  ["rule_checking", "classified"],
  ["rule_checking", "failed"],
  ["classified", "unit_processing"],
  ["unit_processing", "done"],
  ["failed", "queued"],
];
const isValid = (f: Status, t: Status) => VALID.some(([a, b]) => a === f && b === t);

describe("status table", () => {
  it("has Vietnamese labels for all statuses", () => {
    expect(STATUSES).toHaveLength(7);
    expect(STATUS_LABELS.queued).toBe("Hàng đợi");
    expect(STATUS_LABELS.failed).toBe("Lỗi");
    for (const s of STATUSES) expect(STATUS_LABELS[s]).toBeTruthy();
  });
  it("ALLOWED_TRANSITIONS equals the spec list exactly", () => {
    const edges = STATUSES.flatMap((f) => ALLOWED_TRANSITIONS[f].map((t) => [f, t]));
    expect(edges.sort()).toEqual([...VALID].sort());
  });
});

describe.skipIf(mode !== "run")("transition", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let userId: number;

  beforeAll(async () => {
    t = await createTestDb();
    const [u] = await t.db
      .insert(schema.users)
      .values({ username: "actor", passwordHash: "x", role: "user" })
      .returning();
    userId = u.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });
  beforeEach(async () => {
    await t.db.execute(sql`drop trigger if exists boom on document_events`);
    await t.db.delete(schema.documents);
  });

  async function mk(status: Status = "queued", error: string | null = null) {
    const [d] = await t.db
      .insert(schema.documents)
      .values({ filename: "a.pdf", pdfPath: "/a.pdf", status, error })
      .returning();
    return d.id;
  }
  const events = (id: string) =>
    t.db.select().from(schema.documentEvents).where(eq(schema.documentEvents.documentId, id)).orderBy(schema.documentEvents.id);
  const doc = async (id: string) =>
    (await t.db.select().from(schema.documents).where(eq(schema.documents.id, id)))[0];

  it("full matrix: valid edges succeed, every other pair throws", async () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const id = await mk(from);
        if (from === to) {
          expect(await transition(id, to, {}, t.db)).toEqual({ changed: false, from, to });
          expect(await events(id)).toHaveLength(0);
        } else if (isValid(from, to)) {
          expect(await transition(id, to, {}, t.db)).toEqual({ changed: true, from, to });
          expect((await doc(id)).status).toBe(to);
          expect(await events(id)).toHaveLength(1);
        } else {
          const err = await transition(id, to, {}, t.db).catch((e) => e);
          expect(err).toBeInstanceOf(InvalidTransitionError);
          expect(err.from).toBe(from);
          expect(err.to).toBe(to);
          expect((await doc(id)).status).toBe(from);
          expect(await events(id)).toHaveLength(0);
        }
      }
    }
  });

  it("writes one event with from/to/actor/note", async () => {
    const id = await mk();
    await transition(id, "ocr_processing", { actorId: userId, note: "bắt đầu" }, t.db);
    const ev = await events(id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ fromStatus: "queued", toStatus: "ocr_processing", actorId: userId, note: "bắt đầu" });
    const d = await doc(id);
    expect(d.updatedAt.getTime()).toBeGreaterThanOrEqual(d.createdAt.getTime());
  });

  it("actor/note default to null", async () => {
    const id = await mk();
    await transition(id, "ocr_processing", undefined, t.db);
    const [e] = await events(id);
    expect(e.actorId).toBeNull();
    expect(e.note).toBeNull();
  });

  it("failed stores truncated error; retry clears it", async () => {
    const id = await mk("ocr_processing");
    await transition(id, "failed", { error: "x".repeat(5000) }, t.db);
    expect((await doc(id)).error).toHaveLength(2000);
    await transition(id, "queued", {}, t.db);
    const d = await doc(id);
    expect(d.status).toBe("queued");
    expect(d.error).toBeNull();
  });

  it("unknown id throws DocumentNotFoundError", async () => {
    await expect(transition("00000000-0000-0000-0000-000000000000", "queued", {}, t.db)).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
  });

  it("failing event insert rolls back status change", async () => {
    const id = await mk();
    await t.db.execute(sql`create or replace function boom_fn() returns trigger as $$ begin raise exception 'boom'; end $$ language plpgsql`);
    await t.db.execute(sql`create trigger boom before insert on document_events for each row execute function boom_fn()`);
    const err = await transition(id, "ocr_processing", {}, t.db).catch((e) => e);
    expect(String((err as Error).cause ?? err)).toMatch(/boom/);
    expect((await doc(id)).status).toBe("queued");
  });

  it("concurrent identical transitions: exactly one wins", async () => {
    const id = await mk();
    const rs = await Promise.all([
      transition(id, "ocr_processing", {}, t.db),
      transition(id, "ocr_processing", {}, t.db),
    ]);
    expect(rs.filter((r) => r.changed)).toHaveLength(1);
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
    // Round-trip trên chính kết nối LISTEN: thông báo đã commit được giao trước khi truy vấn này trả về.
    const settle = () => listener.query("select 1");

    it("delivers once after commit", async () => {
      const id = await mk();
      got.length = 0;
      await transition(id, "ocr_processing", {}, t.db);
      await settle();
      expect(got.map((p) => JSON.parse(p))).toEqual([{ documentId: id, from: "queued", to: "ocr_processing" }]);
    });

    it("no-op and rollback send nothing", async () => {
      const id = await mk();
      got.length = 0;
      await transition(id, "queued", {}, t.db);
      await t.db.execute(sql`create or replace function boom_fn() returns trigger as $$ begin raise exception 'boom'; end $$ language plpgsql`);
      await t.db.execute(sql`create trigger boom before insert on document_events for each row execute function boom_fn()`);
      await transition(id, "ocr_processing", {}, t.db).catch(() => {});
      await settle();
      expect(got).toEqual([]);
    });
    it("composes with caller's tx: commit keeps everything and notifies once", async () => {
      const id = await mk();
      got.length = 0;
      await t.db.transaction(async (tx) => {
        await tx.update(schema.documents).set({ needsManual: true }).where(eq(schema.documents.id, id));
        await transition(id, "ocr_processing", {}, tx);
      });
      await settle();
      const d = await doc(id);
      expect(d.status).toBe("ocr_processing");
      expect(d.needsManual).toBe(true);
      expect(await events(id)).toHaveLength(1);
      expect(got).toHaveLength(1);
    });

    it("composes with caller's tx: throw after transition rolls back everything, no notify", async () => {
      const id = await mk();
      got.length = 0;
      await expect(
        t.db.transaction(async (tx) => {
          await tx.update(schema.documents).set({ needsManual: true }).where(eq(schema.documents.id, id));
          await transition(id, "ocr_processing", {}, tx);
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      await settle();
      const d = await doc(id);
      expect(d.status).toBe("queued");
      expect(d.needsManual).toBe(false);
      expect(await events(id)).toHaveLength(0);
      expect(got).toEqual([]);
    });
  });
});
