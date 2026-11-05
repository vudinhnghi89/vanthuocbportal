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

import { getRuleDraftFromDocument } from "@/server/rule-draft";
import { classifyDocument } from "@/server/document-detail";
import { createRule } from "@/server/rules";
import { runRuleCheck } from "@/matching/run";
import type { DbLike } from "@/server/status";

const mode = dbSuiteMode(process.env);
const NIL = "00000000-0000-4000-8000-000000000000";

describe.skipIf(mode !== "run")("getRuleDraftFromDocument", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: DbLike;
  let unitA: number, unitB: number, sec: number;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db as unknown as DbLike;
    holder.db = t.db;
    await t.db.insert(schema.users).values({ id: 1, username: "admin", passwordHash: "x", role: "admin" });
    const us = await t.db
      .insert(schema.units)
      .values([{ name: "Phòng A" }, { name: "Phòng B" }, { name: "Ban thư ký", isSecretariat: true }])
      .returning();
    [unitA, unitB, sec] = us.map((u) => u.id);
  }, 30_000);
  afterAll(async () => {
    await t?.cleanup();
  }, 30_000);
  beforeEach(async () => {
    await t.db.delete(schema.documents);
    await t.db.delete(schema.rules);
  });

  const mk = async (over: Partial<typeof schema.documents.$inferInsert> = {}) =>
    (await t.db.insert(schema.documents).values({ filename: "a.pdf", pdfPath: "/secret/a.pdf", mdPath: "/secret/a.md", ...over }).returning())[0];

  it("fills fields from extracted JSON (alias keys), missing -> ''", async () => {
    const d = await mk({ extracted: { co_quan_ban_hanh: "Bộ Y tế", loai_cong_van: ["Công văn"], trich_yeu: "Về việc X" } });
    expect(await getRuleDraftFromDocument(d.id, db)).toEqual({
      issuer: "Bộ Y tế", docType: "Công văn", title: "", summary: "Về việc X",
      mainUnitId: null, infoUnitId: null, documentId: d.id, filename: "a.pdf",
    });
  });

  it("null/garbage extracted -> empty fields", async () => {
    const d1 = await mk({ extracted: null });
    const d2 = await mk({ extracted: [1, 2] });
    for (const d of [d1, d2]) {
      expect(await getRuleDraftFromDocument(d.id, db)).toMatchObject({ issuer: "", docType: "", title: "", summary: "" });
    }
  });

  it("units only after a manual classification", async () => {
    const pending = await mk({ status: "classified", needsManual: true, matchMethod: "none", infoUnitId: sec });
    expect(await getRuleDraftFromDocument(pending.id, db)).toMatchObject({ mainUnitId: null, infoUnitId: null });
    const viaRule = await mk({ status: "classified", needsManual: false, matchMethod: "single", mainUnitId: unitA, infoUnitId: unitB });
    expect(await getRuleDraftFromDocument(viaRule.id, db)).toMatchObject({ mainUnitId: null, infoUnitId: null });
    const manual = await mk({ status: "classified", needsManual: false, matchMethod: "none", mainUnitId: unitA, infoUnitId: unitB });
    expect(await getRuleDraftFromDocument(manual.id, db)).toMatchObject({ mainUnitId: unitA, infoUnitId: unitB });
    const manualNoInfo = await mk({ status: "classified", needsManual: false, matchMethod: "none", mainUnitId: unitA, infoUnitId: null });
    expect(await getRuleDraftFromDocument(manualNoInfo.id, db)).toMatchObject({ mainUnitId: unitA, infoUnitId: null });
  });

  it("unknown id -> null; no sensitive fields", async () => {
    expect(await getRuleDraftFromDocument(NIL, db)).toBeNull();
    expect(await getRuleDraftFromDocument("nope", db)).toBeNull();
    const d = await mk({ extracted: { issuer: "X", docType: "Y" } });
    const text = JSON.stringify(await getRuleDraftFromDocument(d.id, db));
    expect(text).not.toContain("secret");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      ["docType", "documentId", "filename", "infoUnitId", "issuer", "mainUnitId", "summary", "title"],
    );
  });

  it("feedback loop: no rule -> none/manual -> classify -> draft -> createRule -> next similar doc matches", async () => {
    const extracted = { co_quan_ban_hanh: "Sở Tài chính", loai_cong_van: "Thông báo", tieu_de: "Lịch họp", tom_tat: "Họp giao ban" };
    const first = await mk({ status: "rule_checking", extracted });
    expect(await runRuleCheck(first.id, { db, readMarkdown: async () => "" })).toEqual({ method: "none", ruleId: null });
    const afterCheck = (await t.db.select().from(schema.documents).where(eq(schema.documents.id, first.id)))[0];
    expect(afterCheck).toMatchObject({ status: "classified", needsManual: true, matchMethod: "none", mainUnitId: null, infoUnitId: sec });
    // Trước khi phân loại: bản nháp chưa có đơn vị.
    expect(await getRuleDraftFromDocument(first.id, db)).toMatchObject({ mainUnitId: null, infoUnitId: null });

    await classifyDocument(first.id, { mainUnitId: unitA, infoUnitId: unitB }, 1, db);
    const draft = (await getRuleDraftFromDocument(first.id, db))!;
    expect(draft).toMatchObject({
      issuer: "Sở Tài chính", docType: "Thông báo", title: "Lịch họp", summary: "Họp giao ban", mainUnitId: unitA, infoUnitId: unitB,
    });

    const rule = await createRule(
      { issuer: draft.issuer, docType: draft.docType, title: draft.title, summary: draft.summary, mainUnitId: draft.mainUnitId!, infoUnitId: draft.infoUnitId, priority: 0 },
      1,
      db as never,
    );

    const second = await mk({ status: "rule_checking", extracted: { ...extracted, tieu_de: "Lịch họp tuần sau" } });
    expect(await runRuleCheck(second.id, { db, readMarkdown: async () => "" })).toEqual({ method: "single", ruleId: rule.id });
    const row = (await t.db.select().from(schema.documents).where(eq(schema.documents.id, second.id)))[0];
    expect(row).toMatchObject({ needsManual: false, matchMethod: "single", mainUnitId: unitA, infoUnitId: unitB, matchedRuleId: rule.id });
  });
});
