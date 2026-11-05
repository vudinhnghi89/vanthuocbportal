import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { transition } from "@/server/status";
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

import { GET } from "@/app/api/events/route";
import { configureEvents, stopEvents, subscriberCount } from "@/server/events";

const mode = dbSuiteMode(process.env);

describe.skipIf(mode !== "run")("GET /api/events with real LISTEN", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
    configureEvents({ connectionString: t.url });
  }, 30_000);
  afterEach(async () => {
    await stopEvents();
    await t.db.delete(schema.documents);
  });
  afterAll(async () => {
    await t?.cleanup();
  }, 30_000);

  it("streams an enriched data frame after a transition, and releases on abort", async () => {
    authMock.mockResolvedValue({ user: { id: 1, username: "u", role: "user", active: true }, expires: "2099-01-01" });
    const [main, info] = await t.db.insert(schema.units).values([{ name: "Phòng A" }, { name: "Phòng B" }]).returning();
    const [doc] = await t.db
      .insert(schema.documents)
      .values({ filename: "cv.pdf", pdfPath: "/p.pdf", status: "rule_checking", mainUnitId: main.id, infoUnitId: info.id, matchMethod: "agent" })
      .returning();
    const ctl = new AbortController();
    const res = await GET(new Request("http://x/api/events", { signal: ctl.signal }));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = dec.decode((await reader.read()).value);
    expect(buf).toBe("retry: 3000\n\n: connected\n\n");
    buf = "";
    // đợi LISTEN sẵn sàng rồi mới chuyển trạng thái
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    await transition(doc.id, "classified", {}, t.db);
    while (!buf.includes("\n\n")) buf += dec.decode((await reader.read()).value);
    expect(Date.now() - started).toBeLessThan(2000);
    const lines = Object.fromEntries(buf.trim().split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
    expect(lines.event).toBe("document");
    expect(JSON.parse(lines.data)).toMatchObject({
      documentId: doc.id, filename: "cv.pdf", status: "classified", matchMethod: "agent",
      mainUnit: { name: "Phòng A" }, infoUnit: { name: "Phòng B" },
    });
    ctl.abort();
    expect(subscriberCount()).toBe(0);
  });
});
