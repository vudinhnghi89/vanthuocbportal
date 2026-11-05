import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import * as schema from "@/db/schema";
import { DOC_EVENTS_CHANNEL, transition } from "@/server/status";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({
  get db() {
    return holder.db;
  },
}));

import {
  configureEvents,
  stopEvents,
  subscribe,
  subscriberCount,
  TooManySubscribersError,
  type ServerEvent,
  type LoadDocument,
  listenClientConfig,
} from "@/server/events";

const mode = dbSuiteMode(process.env);

async function until(cond: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}

describe.skipIf(mode !== "run")("server events (LISTEN doc_events)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let admin: Client;
  let mainId: number;
  let infoId: number;

  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
    const [m, i] = await t.db
      .insert(schema.units)
      .values([{ name: "Phòng A" }, { name: "Phòng B" }])
      .returning();
    mainId = m.id;
    infoId = i.id;
    admin = new Client({ connectionString: t.url });
    await admin.connect();
  }, 30_000);
  afterAll(async () => {
    await admin?.end();
    await t?.cleanup();
  }, 30_000);
  beforeEach(() => {
    configureEvents({ connectionString: t.url, backoffMinMs: 20, backoffMaxMs: 100 });
  });
  afterEach(async () => {
    await stopEvents();
    await t.db.delete(schema.documents);
  });

  const mkDoc = async (o: Partial<typeof schema.documents.$inferInsert> = {}) =>
    (
      await t.db
        .insert(schema.documents)
        .values({ filename: "cv-01.pdf", pdfPath: "/secret/a.pdf", mdPath: "/secret/a.md", status: "rule_checking", ...o })
        .returning()
    )[0].id;
  const listenerBackends = async () =>
    (
      await admin.query<{ pid: number }>(
        `select pid from pg_stat_activity where datname = current_database() and query like 'LISTEN %' and pid <> pg_backend_pid()`,
      )
    ).rows.map((r) => r.pid);

  it("a real transition() yields one enriched event with both units", async () => {
    const id = await mkDoc({ mainUnitId: mainId, infoUnitId: infoId, matchMethod: "single" });
    const got: ServerEvent[] = [];
    subscribe((e) => got.push(e));
    await until(async () => (await listenerBackends()).length === 1);
    await transition(id, "classified", {}, t.db);
    await until(() => got.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      type: "document.status",
      documentId: id,
      filename: "cv-01.pdf",
      from: "rule_checking",
      status: "classified",
      needsManual: false,
      matchMethod: "single",
      mainUnit: { id: mainId, name: "Phòng A" },
      infoUnit: { id: infoId, name: "Phòng B" },
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const json = JSON.stringify(got[0]);
    expect(json).not.toContain("/secret");
    expect(Object.keys(got[0]).sort()).toEqual(
      ["at", "documentId", "filename", "from", "infoUnit", "mainUnit", "matchMethod", "needsManual", "status", "type"].sort(),
    );
  });

  it("units null and needsManual carried through", async () => {
    const id = await mkDoc({ needsManual: true, matchMethod: "none" });
    const got: ServerEvent[] = [];
    subscribe((e) => got.push(e));
    await until(async () => (await listenerBackends()).length === 1);
    await transition(id, "classified", {}, t.db);
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ needsManual: true, matchMethod: "none", mainUnit: null, infoUnit: null });
  });

  it("two subscribers both receive it; enrichment runs once", async () => {
    const id = await mkDoc();
    const loadDocument = vi.fn<LoadDocument>(async () => ({
      filename: "x.pdf", needsManual: false, matchMethod: null, mainUnit: null, infoUnit: null,
    }));
    configureEvents({ loadDocument });
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    subscribe((e) => a.push(e));
    subscribe((e) => b.push(e));
    await until(async () => (await listenerBackends()).length === 1);
    await transition(id, "classified", {}, t.db);
    await until(() => a.length === 1 && b.length === 1);
    expect(loadDocument).toHaveBeenCalledTimes(1);
    expect(a[0]).toBe(b[0]);
    expect((await listenerBackends()).length).toBe(1); // một kết nối dùng chung
  });

  it("kết nối LISTEN bật TCP keepAlive", () => {
    expect(listenClientConfig("postgres://x/y")).toMatchObject({ keepAlive: true, connectionString: "postgres://x/y" });
  });

  it("truy vấn bổ sung dữ liệu bị treo chỉ bị bỏ qua sau thời hạn, không chặn các sự kiện sau", async () => {
    const a = await mkDoc();
    const b = await mkDoc({ filename: "b.pdf" });
    const loadDocument = vi.fn<LoadDocument>(async (id) => {
      if (id === a) return new Promise(() => {}); // treo mãi
      return { filename: "b.pdf", needsManual: false, matchMethod: null, mainUnit: null, infoUnit: null };
    });
    configureEvents({ loadDocument, loadTimeoutMs: 100 });
    const got: ServerEvent[] = [];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    subscribe((e) => got.push(e));
    await until(async () => (await listenerBackends()).length === 1);
    await transition(a, "classified", {}, t.db);
    await transition(b, "classified", {}, t.db);
    await until(() => got.length === 1, 3000);
    expect(got[0]).toMatchObject({ documentId: b });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("garbage payloads are ignored; valid ones after still delivered", async () => {
    const id = await mkDoc();
    const loadDocument = vi.fn<LoadDocument>(async () => ({
      filename: "x.pdf", needsManual: false, matchMethod: null, mainUnit: null, infoUnit: null,
    }));
    configureEvents({ loadDocument });
    const got: ServerEvent[] = [];
    subscribe((e) => got.push(e));
    await until(async () => (await listenerBackends()).length === 1);
    const bad = [
      "not json", "null", "[]", "5", "{}",
      JSON.stringify({ documentId: "nope", from: "queued", to: "ocr_processing" }),
      JSON.stringify({ documentId: id, from: "bogus", to: "done" }),
      JSON.stringify({ documentId: id, from: "queued" }),
      JSON.stringify({ documentId: 5, from: "queued", to: "done" }),
    ];
    for (const p of bad) await admin.query("select pg_notify($1, $2)", [DOC_EVENTS_CHANNEL, p]);
    await admin.query("select pg_notify($1, $2)", [DOC_EVENTS_CHANNEL, JSON.stringify({ documentId: id, from: "queued", to: "ocr_processing" })]);
    await until(() => got.length === 1);
    expect(loadDocument).toHaveBeenCalledTimes(1);
    expect(got[0]).toMatchObject({ status: "ocr_processing" });
  });

  it("skips events for documents that vanished", async () => {
    const got: ServerEvent[] = [];
    subscribe((e) => got.push(e));
    await until(async () => (await listenerBackends()).length === 1);
    const ghost = "00000000-0000-4000-8000-000000000000";
    await admin.query("select pg_notify($1, $2)", [DOC_EVENTS_CHANNEL, JSON.stringify({ documentId: ghost, from: "queued", to: "ocr_processing" })]);
    const id = await mkDoc();
    await admin.query("select pg_notify($1, $2)", [DOC_EVENTS_CHANNEL, JSON.stringify({ documentId: id, from: "queued", to: "ocr_processing" })]);
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ documentId: id });
  });

  it("a throwing listener does not break others; unsubscribe removes", async () => {
    const id = await mkDoc();
    const good: ServerEvent[] = [];
    const removed: ServerEvent[] = [];
    subscribe(() => {
      throw new Error("boom");
    });
    subscribe((e) => good.push(e));
    const off = subscribe((e) => removed.push(e));
    await until(async () => (await listenerBackends()).length === 1);
    off();
    expect(subscriberCount()).toBe(2);
    await transition(id, "classified", {}, t.db);
    await until(() => good.length === 1);
    expect(removed).toHaveLength(0);
  });

  it("unsubscribing twice is harmless; last unsubscribe closes the LISTEN connection", async () => {
    const off = subscribe(() => {});
    await until(async () => (await listenerBackends()).length === 1);
    off();
    off();
    expect(subscriberCount()).toBe(0);
    await until(async () => (await listenerBackends()).length === 0);
  });

  it("caps subscribers with a typed error", () => {
    configureEvents({ maxSubscribers: 2 });
    subscribe(() => {});
    subscribe(() => {});
    expect(() => subscribe(() => {})).toThrow(TooManySubscribersError);
    expect(subscriberCount()).toBe(2);
  });

  it("defaults to a 200 subscriber cap", () => {
    const offs = Array.from({ length: 200 }, () => subscribe(() => {}));
    expect(() => subscribe(() => {})).toThrow(TooManySubscribersError);
    offs.forEach((f) => f());
  });

  it("reconnects after the listener backend is terminated, sends exactly one resync, still delivers", async () => {
    const id = await mkDoc();
    const got: ServerEvent[] = [];
    subscribe((e) => got.push(e));
    await until(async () => (await listenerBackends()).length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toHaveLength(0); // không resync ở lần kết nối đầu
    const [pid] = await listenerBackends();
    await admin.query("select pg_terminate_backend($1)", [pid]);
    await until(async () => {
      const now = await listenerBackends();
      return now.length === 1 && now[0] !== pid;
    });
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ type: "resync", at: expect.stringMatching(/^\d{4}-/) });
    await transition(id, "classified", {}, t.db);
    await until(() => got.length === 2);
    expect(got[1]).toMatchObject({ type: "document.status", status: "classified" });
    await new Promise((r) => setTimeout(r, 100));
    expect(got.filter((e) => e.type === "resync")).toHaveLength(1);
  });

  it("stopEvents closes the connection, clears subscribers and pending timers", async () => {
    subscribe(() => {});
    await until(async () => (await listenerBackends()).length === 1);
    await stopEvents();
    expect(subscriberCount()).toBe(0);
    await until(async () => (await listenerBackends()).length === 0);
  });

  it("stopEvents while the server is unreachable cancels the retry loop", async () => {
    configureEvents({ connectionString: "postgres://vtp:vtp@127.0.0.1:1/none", backoffMinMs: 10, backoffMaxMs: 20 });
    subscribe(() => {});
    await new Promise((r) => setTimeout(r, 100));
    await stopEvents();
    expect(subscriberCount()).toBe(0);
  });
});
