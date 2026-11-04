import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import * as schema from "@/db/schema";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";
import { runRuleCheck, InvalidStateError, SecretariatMissingError } from "@/matching/run";
import { DocumentNotFoundError, DOC_EVENTS_CHANNEL, type Status } from "@/server/status";
import type { Rule } from "@/server/rules";

const mode = dbSuiteMode(process.env);

describe.skipIf(mode !== "run")("runRuleCheck", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let main1: number, main2: number, info1: number, sec: number;
  let secRow: typeof schema.units.$inferSelect;

  beforeAll(async () => {
    t = await createTestDb();
    const us = await t.db
      .insert(schema.units)
      .values([{ name: "Phòng A" }, { name: "Phòng B" }, { name: "Phòng C" }, { name: "Ban thư ký", isSecretariat: true }])
      .returning();
    main1 = us[0].id;
    main2 = us[1].id;
    info1 = us[2].id;
    sec = us[3].id;
    secRow = us[3];
  });
  afterAll(async () => {
    await t?.cleanup();
  });
  beforeEach(async () => {
    await t.db.execute(sql`drop trigger if exists boom on document_events`);
    await t.db.delete(schema.documents);
    await t.db.delete(schema.rules);
    await t.db.delete(schema.issuerAliases);
    const has = await t.db.select().from(schema.units).where(eq(schema.units.isSecretariat, true));
    if (has.length === 0) await t.db.insert(schema.units).values({ id: secRow.id, name: secRow.name, isSecretariat: true });
  });

  const mkRule = async (v: Partial<typeof schema.rules.$inferInsert> = {}) =>
    (
      await t.db
        .insert(schema.rules)
        .values({ issuer: "Bộ Y Tế", docType: "Thông tư", title: "T", mainUnitId: main1, infoUnitId: info1, ...v })
        .returning()
    )[0];
  const mkDoc = async (
    over: Partial<typeof schema.documents.$inferInsert> = {},
    extracted: unknown = { co_quan_ban_hanh: "Bộ Y Tế", loai_cong_van: "Thông tư" },
  ) =>
    (
      await t.db
        .insert(schema.documents)
        .values({ filename: "a.pdf", pdfPath: "/a.pdf", status: "rule_checking", extracted, ...over })
        .returning()
    )[0].id;
  const doc = async (id: string) => (await t.db.select().from(schema.documents).where(eq(schema.documents.id, id)))[0];
  const events = (id: string) =>
    t.db.select().from(schema.documentEvents).where(eq(schema.documentEvents.documentId, id));
  const read = async () => "# md";

  it("(a) single", async () => {
    const r = await mkRule();
    const id = await mkDoc();
    const dis = vi.fn();
    const out = await runRuleCheck(id, { disambiguate: dis, readMarkdown: read, db: t.db });
    expect(out).toEqual({ method: "single", ruleId: r.id });
    expect(dis).not.toHaveBeenCalled();
    const d = await doc(id);
    expect(d).toMatchObject({
      status: "classified", matchedRuleId: r.id, matchMethod: "single",
      mainUnitId: main1, infoUnitId: info1, needsManual: false,
    });
    const ev = await events(id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ fromStatus: "rule_checking", toStatus: "classified" });
  });

  it("(b) agent picks one", async () => {
    const r1 = await mkRule();
    const r2 = await mkRule({ mainUnitId: main2, title: "T2" });
    const id = await mkDoc({ mdPath: "/x/doc.md" });
    const dis = vi.fn(async (_m: string, c: Rule[]) => c.find((x) => x.id === r2.id) ?? null);
    const out = await runRuleCheck(id, { disambiguate: dis, readMarkdown: read, db: t.db });
    expect(dis).toHaveBeenCalledTimes(1);
    expect(dis.mock.calls[0][0]).toBe("# md");
    expect(dis.mock.calls[0][1]).toHaveLength(2);
    expect(out).toEqual({ method: "agent", ruleId: r2.id });
    expect(await doc(id)).toMatchObject({ matchMethod: "agent", matchedRuleId: r2.id, mainUnitId: main2, needsManual: false });
    expect(r1.id).not.toBe(r2.id);
  });

  it("(c) agent null -> none fallback", async () => {
    await mkRule();
    await mkRule({ title: "T2" });
    const id = await mkDoc();
    const out = await runRuleCheck(id, { disambiguate: async () => null, readMarkdown: read, db: t.db });
    expect(out).toEqual({ method: "none", ruleId: null });
    expect(await doc(id)).toMatchObject({
      status: "classified", matchMethod: "none", matchedRuleId: null, mainUnitId: null, infoUnitId: sec, needsManual: true,
    });
  });

  it("(d) zero matches", async () => {
    await mkRule();
    const id = await mkDoc({}, { co_quan_ban_hanh: "Cơ quan lạ", loai_cong_van: "Thông tư" });
    const dis = vi.fn();
    const out = await runRuleCheck(id, { disambiguate: dis, readMarkdown: read, db: t.db });
    expect(out).toEqual({ method: "none", ruleId: null });
    expect(dis).not.toHaveBeenCalled();
    expect(await doc(id)).toMatchObject({
      matchMethod: "none", matchedRuleId: null, mainUnitId: null, infoUnitId: sec, needsManual: true, status: "classified",
    });
  });

  it("(e) docType mismatch -> none", async () => {
    await mkRule();
    const id = await mkDoc({}, { co_quan_ban_hanh: "Bộ Y Tế", loai_cong_van: "Quyết định" });
    expect((await runRuleCheck(id, { readMarkdown: read, db: t.db }))?.method).toBe("none");
  });

  it("(f) null infoUnitId stays null", async () => {
    await mkRule({ infoUnitId: null });
    const id = await mkDoc();
    await runRuleCheck(id, { readMarkdown: read, db: t.db });
    expect(await doc(id)).toMatchObject({ matchMethod: "single", infoUnitId: null, mainUnitId: main1 });
  });

  it("(g) inactive rules ignored", async () => {
    await mkRule({ active: false });
    const id = await mkDoc();
    expect((await runRuleCheck(id, { readMarkdown: read, db: t.db }))?.method).toBe("none");
  });

  it("(h) diacritics/case variant and alias", async () => {
    const r = await mkRule();
    const id = await mkDoc({}, { co_quan_ban_hanh: "bo y te ", loai_cong_van: "THÔNG TƯ" });
    expect(await runRuleCheck(id, { readMarkdown: read, db: t.db })).toEqual({ method: "single", ruleId: r.id });
    await t.db.insert(schema.issuerAliases).values({ alias: "BYT", canonicalIssuer: "Bộ Y Tế", aliasNorm: "byt" });
    const id2 = await mkDoc({}, { co_quan_ban_hanh: "BYT", loai_cong_van: "Thông tư" });
    expect(await runRuleCheck(id2, { readMarkdown: read, db: t.db })).toEqual({ method: "single", ruleId: r.id });
  });

  it("(i) idempotent, invalid states, unknown id", async () => {
    await mkRule();
    const id = await mkDoc();
    await runRuleCheck(id, { readMarkdown: read, db: t.db });
    const before = await doc(id);
    expect(await runRuleCheck(id, { readMarkdown: read, db: t.db })).toBeNull();
    expect(await events(id)).toHaveLength(1);
    expect((await doc(id)).updatedAt).toEqual(before.updatedAt);
    for (const s of ["unit_processing", "done"] as Status[]) {
      const x = await mkDoc({ status: s });
      expect(await runRuleCheck(x, { db: t.db })).toBeNull();
    }
    for (const s of ["queued", "ocr_processing", "failed"] as Status[]) {
      const x = await mkDoc({ status: s });
      await expect(runRuleCheck(x, { db: t.db })).rejects.toBeInstanceOf(InvalidStateError);
    }
    await expect(runRuleCheck("00000000-0000-4000-8000-000000000000", { db: t.db })).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
  });

  it("(j) no secretariat -> SecretariatMissingError, doc untouched", async () => {
    await mkRule();
    const id = await mkDoc();
    await t.db.delete(schema.units).where(eq(schema.units.isSecretariat, true));
    await expect(runRuleCheck(id, { readMarkdown: read, db: t.db })).rejects.toBeInstanceOf(SecretariatMissingError);
    expect(await doc(id)).toMatchObject({ status: "rule_checking", matchMethod: null, matchedRuleId: null });
    expect(await events(id)).toHaveLength(0);
  });

  it("(k) missing md file / null md_path -> empty markdown", async () => {
    await mkRule();
    await mkRule({ title: "T2" });
    const seen: string[] = [];
    const dis = async (m: string) => {
      seen.push(m);
      return null;
    };
    const id1 = await mkDoc({ mdPath: null });
    await runRuleCheck(id1, { disambiguate: dis, db: t.db });
    const id2 = await mkDoc({ mdPath: "/nonexistent/zzz.md" });
    await runRuleCheck(id2, { disambiguate: dis, db: t.db });
    expect(seen).toEqual(["", ""]);
    expect((await doc(id2)).status).toBe("classified");
  });

  it("(l) atomicity: failing transition rolls back columns", async () => {
    await mkRule();
    const id = await mkDoc();
    await t.db.execute(sql`create or replace function boom_fn() returns trigger as $$ begin raise exception 'boom'; end $$ language plpgsql`);
    await t.db.execute(sql`create trigger boom before insert on document_events for each row execute function boom_fn()`);
    await expect(runRuleCheck(id, { readMarkdown: read, db: t.db })).rejects.toThrow();
    expect(await doc(id)).toMatchObject({ status: "rule_checking", matchMethod: null, matchedRuleId: null, mainUnitId: null });
    await t.db.execute(sql`drop trigger boom on document_events`);
    expect((await runRuleCheck(id, { readMarkdown: read, db: t.db }))?.method).toBe("single");
  });

  it("(m) no row lock held during agent call", async () => {
    await mkRule();
    await mkRule({ title: "T2" });
    const id = await mkDoc();
    const dis = async () => {
      const c = new Client({ connectionString: t.url });
      await c.connect();
      try {
        await c.query("set lock_timeout = '500ms'");
        const res = await c.query("update documents set filename = 'b.pdf' where id = $1", [id]);
        expect(res.rowCount).toBe(1);
      } finally {
        await c.end();
      }
      return null;
    };
    await runRuleCheck(id, { disambiguate: dis, readMarkdown: read, db: t.db });
    expect((await doc(id)).filename).toBe("b.pdf");
  });

  it("(n) concurrent double run -> one event", async () => {
    await mkRule();
    const id = await mkDoc();
    const res = await Promise.all([
      runRuleCheck(id, { readMarkdown: read, db: t.db }),
      runRuleCheck(id, { readMarkdown: read, db: t.db }),
    ]);
    expect(res.filter((r) => r !== null)).toHaveLength(1);
    expect(await events(id)).toHaveLength(1);
    expect((await doc(id)).status).toBe("classified");
  });

  it("(o) notification payload", async () => {
    await mkRule();
    const id = await mkDoc();
    const listener = new Client({ connectionString: t.url });
    await listener.connect();
    const got: string[] = [];
    listener.on("notification", (m) => m.payload && got.push(m.payload));
    await listener.query(`LISTEN ${DOC_EVENTS_CHANNEL}`);
    try {
      await runRuleCheck(id, { readMarkdown: read, db: t.db });
      await listener.query("select 1");
    } finally {
      await listener.end();
    }
    expect(got.map((p) => JSON.parse(p))).toEqual([{ documentId: id, from: "rule_checking", to: "classified" }]);
  });
});
