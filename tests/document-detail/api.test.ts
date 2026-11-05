import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, type Pool } from "pg";
import * as schema from "@/db/schema";
import { DOC_EVENTS_CHANNEL, type Status } from "@/server/status";
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

import { GET as getDetail } from "@/app/api/documents/[id]/route";
import { GET as getFile } from "@/app/api/documents/[id]/file/route";
import { POST as classify } from "@/app/api/documents/[id]/classify/route";

const mode = dbSuiteMode(process.env);
const session = (id = 7) => ({ user: { id, username: "u7", role: "user", active: true }, expires: "2099-01-01" });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const BAD = "not-a-uuid";
const NIL = "00000000-0000-4000-8000-000000000000";

describe.skipIf(mode !== "run")("document detail / file / classify APIs", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let dataDir: string;
  let unitA: number, unitB: number, unitOff: number;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vtp-detail-"));
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(path.join(dataDir, "pdf"));
    fs.mkdirSync(path.join(dataDir, "md"));
    t = await createTestDb();
    holder.db = t.db;
    await t.db.insert(schema.users).values({ id: 7, username: "u7", passwordHash: "x", role: "user" });
    await t.db.insert(schema.users).values({ id: 8, username: "lan", passwordHash: "x", role: "user" });
    const us = await t.db
      .insert(schema.units)
      .values([{ name: "Phòng A" }, { name: "Phòng B" }, { name: "Phòng Off", active: false }])
      .returning();
    [unitA, unitB, unitOff] = us.map((u) => u.id);
  }, 30_000);
  afterAll(async () => {
    await t?.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);
  beforeEach(async () => {
    authMock.mockReset();
    authMock.mockResolvedValue(session());
    await t.db.delete(schema.documents);
  });

  const mk = async (over: Partial<typeof schema.documents.$inferInsert> = {}) =>
    (await t.db.insert(schema.documents).values({ filename: "a.pdf", pdfPath: "/nope/a.pdf", ...over }).returning())[0];
  const events = (id: string) =>
    t.db.select().from(schema.documentEvents).where(eq(schema.documentEvents.documentId, id)).orderBy(asc(schema.documentEvents.id));
  const get = async (id: string) => (await t.db.select().from(schema.documents).where(eq(schema.documents.id, id)))[0];
  const writeMd = (text: string) => {
    const p = path.join(dataDir, "md", `${Math.random().toString(36).slice(2)}.md`);
    fs.writeFileSync(p, text);
    return p;
  };
  const writePdf = (bytes: Buffer) => {
    const p = path.join(dataDir, "pdf", `${Math.random().toString(36).slice(2)}.pdf`);
    fs.writeFileSync(p, bytes);
    return p;
  };

  describe("GET /api/documents/[id]", () => {
    const call = (id: string) => getDetail(new Request(`http://localhost/api/documents/${id}`), ctx(id));

    it("returns fields, events oldest first with actor names, never paths", async () => {
      const md = writeMd("# Xin chào");
      const d = await mk({
        filename: "cv.pdf", status: "classified", mdPath: md, extracted: { tieu_de: "T" }, uploadedBy: 8,
        mainUnitId: unitA, infoUnitId: unitB, matchMethod: "none", needsManual: true,
      });
      await t.db.insert(schema.documentEvents).values([
        { documentId: d.id, fromStatus: null, toStatus: "queued", actorId: 8, at: new Date("2026-01-01T00:00:00Z") as never },
        { documentId: d.id, fromStatus: "queued", toStatus: "ocr_processing", at: new Date("2026-01-01T00:01:00Z") as never },
        { documentId: d.id, fromStatus: "ocr_processing", toStatus: "rule_checking", note: "n", at: new Date("2026-01-01T00:02:00Z") as never },
      ]);
      const res = await call(d.id);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        id: d.id, filename: "cv.pdf", status: "classified", error: null, needsManual: true, matchMethod: "none",
        matchedRuleId: null, mainUnit: { id: unitA, name: "Phòng A" }, infoUnit: { id: unitB, name: "Phòng B" },
        uploadedBy: "lan", extracted: { tieu_de: "T" }, markdown: "# Xin chào", markdownTruncated: false, hasPdf: false,
      });
      expect(typeof body.createdAt).toBe("string");
      expect(typeof body.updatedAt).toBe("string");
      expect(body.events.map((e: { from: unknown; to: string; actor: unknown; note: unknown }) => [e.from, e.to, e.actor, e.note])).toEqual([
        [null, "queued", "lan", null],
        ["queued", "ocr_processing", null, null],
        ["ocr_processing", "rule_checking", null, "n"],
      ]);
      const text = JSON.stringify(body);
      expect(text).not.toContain("pdf_path");
      expect(text).not.toContain("pdfPath");
      expect(text).not.toContain("mdPath");
      expect(text).not.toContain("md_path");
      expect(text).not.toContain(md);
    });

    it("truncates markdown at 100000 chars with flag", async () => {
      const md = writeMd("a".repeat(150_000));
      const d = await mk({ mdPath: md });
      const body = await (await call(d.id)).json();
      expect(body.markdown).toHaveLength(100_000);
      expect(body.markdownTruncated).toBe(true);
    });

    it("exactly at the limit is not truncated", async () => {
      const md = writeMd("b".repeat(100_000));
      const d = await mk({ mdPath: md });
      const body = await (await call(d.id)).json();
      expect(body.markdown).toHaveLength(100_000);
      expect(body.markdownTruncated).toBe(false);
    });

    it("missing md file -> '' and md_path outside DATA_DIR -> ''", async () => {
      const d1 = await mk({ mdPath: path.join(dataDir, "md", "missing.md") });
      const b1 = await (await call(d1.id)).json();
      expect(b1.markdown).toBe("");
      const outside = path.join(os.tmpdir(), `vtp-outside-${Date.now()}.md`);
      fs.writeFileSync(outside, "SECRET");
      const d2 = await mk({ mdPath: outside });
      const d3 = await mk({ mdPath: path.join(dataDir, "md", "..", "..", path.basename(outside)) });
      for (const d of [d2, d3]) {
        const b = await (await call(d.id)).json();
        expect(b.markdown).toBe("");
        expect(b.markdownTruncated).toBe(false);
      }
      fs.rmSync(outside);
      const d4 = await mk({ mdPath: null });
      expect((await (await call(d4.id)).json()).markdown).toBe("");
    });

    it("hasPdf true when file exists inside pdf dir", async () => {
      const d = await mk({ pdfPath: writePdf(Buffer.from("%PDF-1.4 x")) });
      expect((await (await call(d.id)).json()).hasPdf).toBe(true);
    });

    it("unknown 404, bad uuid 400, unauthenticated 401", async () => {
      expect((await call(NIL)).status).toBe(404);
      expect((await call(BAD)).status).toBe(400);
      authMock.mockResolvedValue(null);
      expect((await call(NIL)).status).toBe(401);
    });
  });

  describe("GET /api/documents/[id]/file", () => {
    const call = (id: string) => getFile(new Request(`http://localhost/api/documents/${id}/file`), ctx(id));

    it("streams bytes with hardened headers", async () => {
      const bytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from([0, 1, 2, 255, 254])]);
      const d = await mk({ filename: "Công văn \"số\" 1.pdf", pdfPath: writePdf(bytes) });
      const res = await call(d.id);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      const cd = res.headers.get("content-disposition")!;
      expect(cd.startsWith("inline;")).toBe(true);
      expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent("Công văn \"số\" 1.pdf").replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`);
      expect(cd).toMatch(/filename="[\x20-\x7e]*"/);
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    });

    it("sanitises CRLF and quotes in filename", async () => {
      const d = await mk({ filename: 'a"\r\nX-Evil: 1.pdf', pdfPath: writePdf(Buffer.from("%PDF-")) });
      const res = await call(d.id);
      expect(res.status).toBe(200);
      const cd = res.headers.get("content-disposition")!;
      expect(cd).not.toMatch(/[\r\n]/);
      expect(res.headers.get("x-evil")).toBeNull();
      expect(cd.match(/filename="([^"]*)"/)![1]).not.toContain('"');
    });

    it("body is a stream and large files are intact", async () => {
      const big = Buffer.alloc(8 * 1024 * 1024, 7);
      big.write("%PDF-1.7");
      const d = await mk({ pdfPath: writePdf(big) });
      const res = await call(d.id);
      expect(res.body).toBeInstanceOf(ReadableStream);
      let n = 0;
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
      }
      expect(n).toBe(big.length);
    });

    it("404 for unknown, missing file, tampered paths; 400 bad uuid; 401", async () => {
      expect((await call(NIL)).status).toBe(404);
      expect((await call(BAD)).status).toBe(400);
      const missing = await mk({ pdfPath: path.join(dataDir, "pdf", "gone.pdf") });
      expect((await call(missing.id)).status).toBe(404);
      for (const p of ["/etc/passwd", path.join(dataDir, "pdf", "..", "..", "etc", "passwd"), path.join(dataDir, "md", "x.md")]) {
        const d = await mk({ pdfPath: p });
        const res = await call(d.id);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("passwd");
      }
      authMock.mockResolvedValue(null);
      expect((await call(NIL)).status).toBe(401);
    });
  });

  describe("POST /api/documents/[id]/classify", () => {
    const call = (id: string, body: unknown) =>
      classify(
        new Request(`http://localhost/api/documents/${id}/classify`, {
          method: "POST",
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
        ctx(id),
      );
    const mkManual = (over: Partial<typeof schema.documents.$inferInsert> = {}) =>
      mk({ status: "classified", needsManual: true, matchMethod: "none", ...over });

    it("saves units, clears needs_manual, writes event with actor and note", async () => {
      const d = await mkManual();
      const res = await call(d.id, { mainUnitId: unitA, infoUnitId: unitB });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: d.id, status: "classified", needsManual: false,
        mainUnit: { id: unitA, name: "Phòng A" }, infoUnit: { id: unitB, name: "Phòng B" },
      });
      const row = await get(d.id);
      expect(row).toMatchObject({ mainUnitId: unitA, infoUnitId: unitB, needsManual: false, matchMethod: "none", matchedRuleId: null, status: "classified" });
      expect((await events(d.id)).map((e) => [e.fromStatus, e.toStatus, e.actorId, e.note])).toEqual([
        ["classified", "classified", 7, "Phân loại thủ công: Phòng A / Phòng B"],
      ]);
    });

    it("info optional (note shows —), main==info allowed", async () => {
      const d1 = await mkManual({ infoUnitId: unitB });
      expect((await call(d1.id, { mainUnitId: unitA })).status).toBe(200);
      expect((await get(d1.id)).infoUnitId).toBeNull();
      expect((await events(d1.id))[0].note).toBe("Phân loại thủ công: Phòng A / —");
      const d2 = await mkManual();
      expect((await call(d2.id, { mainUnitId: unitA, infoUnitId: null })).status).toBe(200);
      const d3 = await mkManual();
      expect((await call(d3.id, { mainUnitId: unitA, infoUnitId: unitA })).status).toBe(200);
      expect((await get(d3.id)).infoUnitId).toBe(unitA);
    });

    it("409 when not needs_manual or status not classified", async () => {
      const a = await mk({ status: "classified", needsManual: false });
      const ra = await call(a.id, { mainUnitId: unitA });
      expect(ra.status).toBe(409);
      expect((await ra.json()).error).toBe("Văn bản này không cần phân loại thủ công");
      const b = await mk({ status: "rule_checking", needsManual: true });
      const rb = await call(b.id, { mainUnitId: unitA });
      expect(rb.status).toBe(409);
      expect((await rb.json()).error).toBe("Văn bản chưa ở trạng thái Hoàn tất phân loại");
      expect(await events(a.id)).toHaveLength(0);
      expect(await events(b.id)).toHaveLength(0);
    });

    it.each([
      [{ mainUnitId: -1 }], [{ mainUnitId: 0 }], [{ mainUnitId: 2 ** 31 }], [{ mainUnitId: 1.5 }], [{ mainUnitId: "1" }],
      [{}], [{ infoUnitId: 1 }], [null], [[]], ["{oops"],
    ])("invalid body %j -> 400", async (body) => {
      const d = await mkManual();
      const res = await call(d.id, body);
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
      expect((await get(d.id)).needsManual).toBe(true);
    });

    it("unknown or inactive units -> 400", async () => {
      const d = await mkManual();
      expect((await call(d.id, { mainUnitId: 999999 })).status).toBe(400);
      expect((await call(d.id, { mainUnitId: unitOff })).status).toBe(400);
      expect((await call(d.id, { mainUnitId: unitA, infoUnitId: unitOff })).status).toBe(400);
      expect((await call(d.id, { mainUnitId: unitA, infoUnitId: 999999 })).status).toBe(400);
      expect((await call(d.id, { mainUnitId: unitA, infoUnitId: -3 })).status).toBe(400);
      expect((await get(d.id)).needsManual).toBe(true);
      expect(await events(d.id)).toHaveLength(0);
    });

    it("concurrent calls: exactly one wins, one event", async () => {
      const d = await mkManual();
      const rs = await Promise.all([1, 2, 3].map(() => call(d.id, { mainUnitId: unitA })));
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(await events(d.id)).toHaveLength(1);
    });

    it("unknown 404, bad uuid 400, 401", async () => {
      expect((await call(NIL, { mainUnitId: unitA })).status).toBe(404);
      expect((await call(BAD, { mainUnitId: unitA })).status).toBe(400);
      authMock.mockResolvedValue(null);
      expect((await call(NIL, { mainUnitId: unitA })).status).toBe(401);
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
      it("emits once with {documentId, from, to}", async () => {
        const d = await mkManual();
        got.length = 0;
        await call(d.id, { mainUnitId: unitA });
        await call(d.id, { mainUnitId: unitA });
        await listener.query("select 1");
        const status: Status = "classified";
        expect(got.map((p) => JSON.parse(p))).toEqual([{ documentId: d.id, from: status, to: status }]);
      });
    });
  });
});
