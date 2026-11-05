import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { SecretariatMissingError } from "@/matching/run";
import { transition, type Status } from "@/server/status";
import { handleDeadOcrJob, handleOcrJob, type OcrJobDeps } from "@/worker/jobs/ocr";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";
import { startDifyMock, workflowOk, type DifyMock } from "../mocks/dify-server";

const mode = dbSuiteMode(process.env);
const API_KEY = "app-SECRETKEY1234";
const MD = "# Nội dung markdown RẤT BÍ MẬT";
const JSON_OUT = { co_quan_ban_hanh: "Bộ Y Tế", loai_cong_van: "Thông tư", secret_field: "DU-LIEU-JSON-BI-MAT" };
const FIRST: { retryCount: number; retryLimit: number } = { retryCount: 0, retryLimit: 3 };
const LAST: { retryCount: number; retryLimit: number } = { retryCount: 3, retryLimit: 3 };

describe.skipIf(mode !== "run")("handleOcrJob", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let mock: DifyMock;
  let tmp: string;
  let pdfPath: string;
  let prevData: string | undefined;
  let deps: OcrJobDeps;

  beforeAll(async () => {
    t = await createTestDb();
    mock = await startDifyMock();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vtp-ocr-"));
    prevData = process.env.DATA_DIR;
    process.env.DATA_DIR = tmp;
    pdfPath = path.join(tmp, "in.pdf");
    fs.writeFileSync(pdfPath, "%PDF-1.4 fake");
    deps = { db: t.db as never };
  }, 30_000);
  afterAll(async () => {
    try {
      await mock?.close();
    } finally {
      if (prevData === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevData;
      fs.rmSync(tmp, { recursive: true, force: true });
      await t?.cleanup();
    }
  });

  let main: number;
  beforeEach(async () => {
    await t.db.delete(schema.documents);
    await t.db.delete(schema.rules);
    await t.db.delete(schema.integrationSettings);
    await t.db.delete(schema.units);
    fs.rmSync(path.join(tmp, "md"), { recursive: true, force: true });
    const us = await t.db
      .insert(schema.units)
      .values([{ name: "Phòng A" }, { name: "Phòng B" }, { name: "Ban thư ký", isSecretariat: true }])
      .returning();
    main = us[0].id;
    await t.db.insert(schema.rules).values({ issuer: "Bộ Y Tế", docType: "Thông tư", title: "T", mainUnitId: main, infoUnitId: us[1].id });
    await configure();
    mock.uploads.length = 0;
    mock.runs.length = 0;
    mock.onUpload = () => ({ body: { id: "file-1" } });
    mock.onRun = () => workflowOk({ md: MD, json: JSON_OUT });
  });

  async function configure() {
    await t.db.insert(schema.integrationSettings).values({
      key: "dify_ocr",
      baseUrl: mock.url,
      apiKeyEnc: encryptSecret(API_KEY),
      inputVar: "doc",
      outputVarMd: "md",
      outputVarJson: "json",
      timeoutS: 5,
      retries: 0,
    });
  }
  const mkDoc = async (status: Status = "queued", over: Partial<typeof schema.documents.$inferInsert> = {}) =>
    (await t.db.insert(schema.documents).values({ filename: "a.pdf", pdfPath, status, ...over }).returning())[0].id;
  const get = async (id: string) => (await t.db.select().from(schema.documents).where(eq(schema.documents.id, id)))[0];
  const evs = async (id: string) =>
    (await t.db.select().from(schema.documentEvents).where(eq(schema.documentEvents.documentId, id)).orderBy(asc(schema.documentEvents.id))).map(
      (e) => `${e.fromStatus}>${e.toStatus}`,
    );

  describe("happy path", () => {
    it("queued: saves markdown + extracted, goes queued>ocr_processing>rule_checking>classified", async () => {
      const id = await mkDoc();
      await handleOcrJob(id, FIRST, deps);
      const d = await get(id);
      expect(d.status).toBe("classified");
      expect(d.extracted).toEqual(JSON_OUT);
      expect(d.mdPath && path.dirname(d.mdPath)).toBe(path.join(tmp, "md"));
      expect(fs.readFileSync(d.mdPath!, "utf8")).toBe(MD);
      expect(fs.statSync(d.mdPath!).mode & 0o777).toBe(0o640);
      expect(d.mainUnitId).toBe(main);
      expect(await evs(id)).toEqual(["queued>ocr_processing", "ocr_processing>rule_checking", "rule_checking>classified"]);
      expect(mock.runs).toHaveLength(1);
    });

    it("removes the markdown file when the DB transaction fails", async () => {
      const id = await mkDoc();
      // Tài liệu bị chuyển sang failed ngay khi OCR đang chạy: giao dịch cuối phải thất bại.
      mock.onRun = () => {
        void transition(id, "failed", { error: "x" }, t.db as never);
        return { ...workflowOk({ md: MD, json: JSON_OUT }), delayMs: 300 };
      };
      await handleOcrJob(id, FIRST, deps);
      expect((await get(id)).status).toBe("failed");
      const dir = path.join(tmp, "md");
      expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
      expect((await get(id)).mdPath).toBeNull();
    });
  });

  describe("redelivery", () => {
    it("ocr_processing: runs OCR again", async () => {
      const id = await mkDoc("ocr_processing");
      await handleOcrJob(id, { retryCount: 1, retryLimit: 3 }, deps);
      expect((await get(id)).status).toBe("classified");
      expect(mock.runs).toHaveLength(1);
    });

    it("rule_checking: skips OCR, only runs the rule check", async () => {
      const id = await mkDoc("rule_checking", { extracted: JSON_OUT });
      await handleOcrJob(id, { retryCount: 1, retryLimit: 3 }, deps);
      expect((await get(id)).status).toBe("classified");
      expect(mock.runs).toHaveLength(0);
      expect(mock.uploads).toHaveLength(0);
    });

    it.each(["classified", "unit_processing", "done", "failed"] as const)("%s: no-op", async (st) => {
      const id = await mkDoc(st);
      await handleOcrJob(id, FIRST, deps);
      expect((await get(id)).status).toBe(st);
      expect(mock.runs).toHaveLength(0);
      expect(await evs(id)).toEqual([]);
    });

    it("unknown document id: returns without throwing", async () => {
      await expect(handleOcrJob("00000000-0000-4000-8000-000000000000", FIRST, deps)).resolves.toBeUndefined();
    });
  });

  describe("failure policy", () => {
    it("transient error with retries left: rethrows and the document stays ocr_processing", async () => {
      mock.onRun = () => ({ status: 503, body: { message: "down" } });
      const id = await mkDoc();
      await expect(handleOcrJob(id, FIRST, deps)).rejects.toThrow();
      const d = await get(id);
      expect(d.status).toBe("ocr_processing");
      expect(d.error).toBeNull();
    });

    it("transient error on the last attempt: marks failed and resolves", async () => {
      mock.onRun = () => ({ status: 503, body: { message: "down" } });
      const id = await mkDoc("ocr_processing");
      await expect(handleOcrJob(id, LAST, deps)).resolves.toBeUndefined();
      const d = await get(id);
      expect(d.status).toBe("failed");
      expect(d.error).toContain("DifyHttpError");
      expect(d.error).toMatch(/OCR/);
      expect(await evs(id)).toEqual(["ocr_processing>failed"]);
    });

    it("429 and 408 are transient", async () => {
      for (const status of [429, 408]) {
        mock.onRun = () => ({ status, body: {} });
        const id = await mkDoc();
        await expect(handleOcrJob(id, FIRST, deps)).rejects.toThrow();
        expect((await get(id)).status).toBe("ocr_processing");
      }
    });

    it("permanent: Dify not configured fails immediately on the first attempt", async () => {
      await t.db.delete(schema.integrationSettings);
      const id = await mkDoc();
      await expect(handleOcrJob(id, FIRST, deps)).resolves.toBeUndefined();
      const d = await get(id);
      expect(d.status).toBe("failed");
      expect(d.error).toContain("DifyNotConfiguredError");
      expect(await evs(id)).toEqual(["queued>ocr_processing", "ocr_processing>failed"]);
    });

    it("permanent: missing PDF (ENOENT) fails immediately", async () => {
      const id = await mkDoc("queued", { pdfPath: path.join(tmp, "missing.pdf") });
      await expect(handleOcrJob(id, FIRST, deps)).resolves.toBeUndefined();
      const d = await get(id);
      expect(d.status).toBe("failed");
      expect(d.error).toMatch(/PDF/);
    });

    it("permanent: Dify 401 fails immediately and the error never contains the API key", async () => {
      mock.onUpload = (req) => ({ status: 401, body: { message: `bad ${String(req.headers.authorization)}` } });
      const id = await mkDoc();
      await expect(handleOcrJob(id, FIRST, deps)).resolves.toBeUndefined();
      const d = await get(id);
      expect(d.status).toBe("failed");
      expect(d.error).toContain("DifyHttpError");
      expect(d.error).not.toContain(API_KEY);
    });

    it("error text never contains markdown or JSON contents", async () => {
      const id = await mkDoc();
      const boom = () => Promise.reject(new Error("db down"));
      await handleOcrJob(id, LAST, { ...deps, runRuleCheck: boom });
      const d = await get(id);
      expect(d.status).toBe("failed");
      expect(d.error).not.toContain("BÍ MẬT");
      expect(d.error).not.toContain("BI-MAT");
      expect(d.error).not.toContain(API_KEY);
    });

    it("after exhausting retries, a manual retry (failed>queued) processes the document", async () => {
      mock.onRun = () => ({ status: 503, body: {} });
      const id = await mkDoc();
      await handleOcrJob(id, LAST, deps);
      expect((await get(id)).status).toBe("failed");
      mock.onRun = () => workflowOk({ md: MD, json: JSON_OUT });
      await transition(id, "queued", { note: "Chạy lại" }, t.db as never);
      expect((await get(id)).error).toBeNull();
      await handleOcrJob(id, FIRST, deps);
      expect((await get(id)).status).toBe("classified");
    });

    it("runRuleCheck: SecretariatMissingError is permanent", async () => {
      const id = await mkDoc();
      const calls: string[] = [];
      await handleOcrJob(id, FIRST, {
        ...deps,
        runRuleCheck: async (d) => {
          calls.push(d);
          throw new SecretariatMissingError();
        },
      });
      const d = await get(id);
      expect(d.status).toBe("failed");
      expect(d.error).toContain("SecretariatMissingError");
      expect(calls).toHaveLength(1);
    });

    it("runRuleCheck: generic error is transient; the retry only re-runs the rule check", async () => {
      const id = await mkDoc();
      let n = 0;
      const flaky: OcrJobDeps["runRuleCheck"] = async (docId, d) => {
        if (++n === 1) throw new Error("connection reset");
        const { runRuleCheck } = await import("@/matching/run");
        return runRuleCheck(docId, d);
      };
      await expect(handleOcrJob(id, FIRST, { ...deps, runRuleCheck: flaky })).rejects.toThrow("connection reset");
      expect((await get(id)).status).toBe("rule_checking");
      expect(mock.runs).toHaveLength(1);
      await handleOcrJob(id, { retryCount: 1, retryLimit: 3 }, { ...deps, runRuleCheck: flaky });
      expect((await get(id)).status).toBe("classified");
      expect(mock.runs).toHaveLength(1); // không OCR lại
      expect(await evs(id)).toEqual(["queued>ocr_processing", "ocr_processing>rule_checking", "rule_checking>classified"]);
    });

    it("runRuleCheck transient error on the last attempt marks failed from rule_checking", async () => {
      const id = await mkDoc("rule_checking", { extracted: JSON_OUT });
      await handleOcrJob(id, LAST, { ...deps, runRuleCheck: () => Promise.reject(new Error("db down")) });
      expect((await get(id)).status).toBe("failed");
      expect(await evs(id)).toEqual(["rule_checking>failed"]);
    });

    it("undecryptable settings (wrong APP_SECRET) is transient: failed on the last attempt", async () => {
      const id = await mkDoc();
      // Lỗi giải mã cấu hình (APP_SECRET sai) là lỗi tạm thời.
      const prev = process.env.APP_SECRET;
      process.env.APP_SECRET = "f".repeat(40);
      try {
        await handleOcrJob(id, LAST, deps);
      } finally {
        process.env.APP_SECRET = prev;
      }
      expect((await get(id)).status).toBe("failed");
    });
  });
});

describe.skipIf(mode !== "run")("handleDeadOcrJob", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
  }, 30_000);
  afterAll(async () => {
    await t?.cleanup();
  });
  const mk = async (status: Status) =>
    (await t.db.insert(schema.documents).values({ filename: "a.pdf", pdfPath: "/a.pdf", status }).returning())[0].id;
  const get = async (id: string) => (await t.db.select().from(schema.documents).where(eq(schema.documents.id, id)))[0];

  it.each(["queued", "ocr_processing", "rule_checking"] as const)("%s -> failed with a Vietnamese message", async (st) => {
    const id = await mk(st);
    await handleDeadOcrJob(id, { db: t.db as never });
    const d = await get(id);
    expect(d.status).toBe("failed");
    expect(d.error).toBe("Công việc OCR bị hủy hoặc hết thời gian chờ");
  });

  it("queued goes through ocr_processing (two events)", async () => {
    const id = await mk("queued");
    await handleDeadOcrJob(id, { db: t.db as never });
    const ev = await t.db.select().from(schema.documentEvents).where(eq(schema.documentEvents.documentId, id)).orderBy(asc(schema.documentEvents.id));
    expect(ev.map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual(["queued>ocr_processing", "ocr_processing>failed"]);
  });

  it.each(["classified", "unit_processing", "done", "failed"] as const)("%s -> no-op", async (st) => {
    const id = await mk(st);
    await handleDeadOcrJob(id, { db: t.db as never });
    expect((await get(id)).status).toBe(st);
    expect((await get(id)).error).toBeNull();
  });

  it("unknown id -> no throw", async () => {
    await expect(handleDeadOcrJob("00000000-0000-4000-8000-000000000000", { db: t.db as never })).resolves.toBeUndefined();
  });
});
