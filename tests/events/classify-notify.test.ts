import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import * as schema from "@/db/schema";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({
  get db() {
    return holder.db;
  },
}));

import { configureEvents, stopEvents, subscribe } from "@/server/events";
import { classifyDocument } from "@/server/document-detail";
import type { DbLike } from "@/server/status";

const mode = dbSuiteMode(process.env);

describe.skipIf(mode !== "run")("classify NOTIFY enriched by the events module", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
    configureEvents({ connectionString: t.url });
    await t.db.insert(schema.users).values({ id: 1, username: "u", passwordHash: "x" });
  }, 30_000);
  afterEach(async () => {
    await stopEvents();
    await t.db.delete(schema.documents);
  });
  afterAll(async () => {
    await t?.cleanup();
  }, 30_000);

  it("yields from=classified, status=classified, needsManual=false, units set", async () => {
    const [a, b] = await t.db.insert(schema.units).values([{ name: "Phòng A" }, { name: "Phòng B" }]).returning();
    const [doc] = await t.db
      .insert(schema.documents)
      .values({ filename: "cv.pdf", pdfPath: "/p.pdf", status: "classified", needsManual: true, matchMethod: "none" })
      .returning();
    const got: unknown[] = [];
    subscribe((e) => got.push(e));
    // đợi LISTEN sẵn sàng
    const probe = new Client({ connectionString: t.url });
    await probe.connect();
    await new Promise((r) => setTimeout(r, 300));
    await classifyDocument(doc.id, { mainUnitId: a.id, infoUnitId: b.id }, 1, t.db as unknown as DbLike);
    for (let i = 0; i < 40 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    await probe.end();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      type: "document.status", documentId: doc.id, filename: "cv.pdf", from: "classified", status: "classified",
      needsManual: false, matchMethod: "none", mainUnit: { id: a.id, name: "Phòng A" }, infoUnit: { id: b.id, name: "Phòng B" },
    });
  });
});
