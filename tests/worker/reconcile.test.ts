import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Status } from "@/server/status";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";
import { OCR_QUEUE, getBoss, stopBoss, type QueueOptions } from "@/worker/queue";
import { STUCK_AFTER_SECONDS, failStuckDocuments, reconcileQueuedDocuments, startReconciler } from "@/worker/reconcile";

const mode = dbSuiteMode(process.env);

describe.skipIf(mode !== "run")("reconcileQueuedDocuments", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let queue: QueueOptions;
  let deps: { db: never; queue: QueueOptions };

  beforeAll(async () => {
    t = await createTestDb();
    queue = { connectionString: t.url, retryDelay: 1, retryBackoff: false };
    deps = { db: t.db as never, queue };
    await getBoss(queue);
  }, 30_000);
  afterAll(async () => {
    try {
      await stopBoss(2000);
    } finally {
      await t?.cleanup();
    }
  }, 30_000);
  beforeEach(async () => {
    await t.db.delete(schema.documents);
    await t.db.execute(sql`delete from pgboss.job where name = ${OCR_QUEUE}`);
  });

  const mk = async (status: Status, ageSeconds: number) => {
    const [d] = await t.db.insert(schema.documents).values({ filename: "a.pdf", pdfPath: "/a.pdf", status }).returning();
    await t.db.execute(sql`update documents set updated_at = now() - make_interval(secs => ${ageSeconds}) where id = ${d.id}`);
    return d.id;
  };
  const jobs = async (id: string) => (await (await getBoss(queue)).findJobs(OCR_QUEUE, { key: id })).length;

  it("enqueues stale queued documents once; a second run adds no duplicate", async () => {
    const id = await mk("queued", 120);
    const r1 = await reconcileQueuedDocuments(deps);
    expect(r1).toMatchObject({ enqueued: 1, alreadyQueued: 0, failed: 0 });
    expect(await jobs(id)).toBe(1);
    const r2 = await reconcileQueuedDocuments(deps);
    expect(r2).toMatchObject({ enqueued: 0, alreadyQueued: 1, failed: 0 });
    expect(await jobs(id)).toBe(1);
  });

  it("ignores fresh queued documents and other statuses", async () => {
    const fresh = await mk("queued", 5);
    const failed = await mk("failed", 500);
    const proc = await mk("ocr_processing", 500);
    const r = await reconcileQueuedDocuments(deps);
    expect(r).toMatchObject({ enqueued: 0, alreadyQueued: 0 });
    for (const id of [fresh, failed, proc]) expect(await jobs(id)).toBe(0);
  });

  it("caps each run and takes the oldest first", async () => {
    const oldest = await mk("queued", 900);
    const mid = await mk("queued", 500);
    const newest = await mk("queued", 200);
    const r = await reconcileQueuedDocuments({ ...deps, limit: 2 });
    expect(r.enqueued).toBe(2);
    expect(await jobs(oldest)).toBe(1);
    expect(await jobs(mid)).toBe(1);
    expect(await jobs(newest)).toBe(0);
  });

  it("survives enqueue errors and keeps going", async () => {
    const a = await mk("queued", 300);
    const b = await mk("queued", 200);
    const seen: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await reconcileQueuedDocuments({
      ...deps,
      enqueue: async (id) => {
        seen.push(id);
        if (id === a) throw new Error("secret connection string postgres://u:p@h/db");
        return "job-1";
      },
    });
    expect(r).toMatchObject({ enqueued: 1, failed: 1 });
    expect(seen).toEqual([a, b]);
    const logged = errSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("postgres://");
    errSpy.mockRestore();
  });

  it("startReconciler runs immediately, then on the interval, and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn().mockResolvedValue({ enqueued: 0, alreadyQueued: 0, failed: 0 });
      const rec = startReconciler({ run, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2500);
      expect(run).toHaveBeenCalledTimes(3);
      rec.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(run).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("startReconciler never rejects when a run throws", async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const run = vi.fn().mockRejectedValue(new Error("db down"));
      const rec = startReconciler({ run, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1500);
      expect(run).toHaveBeenCalledTimes(2);
      rec.stop();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  describe("failStuckDocuments", () => {
    const H = 3600;
    const statusOf = async (id: string) =>
      (await t.db.select().from(schema.documents).where(sql`id = ${id}`))[0];
    const eventsOf = async (id: string) =>
      (await t.db.select().from(schema.documentEvents).where(sql`document_id = ${id}`)).map((e) => `${e.fromStatus}>${e.toStatus}`);

    it("STUCK_AFTER = 6 giờ, lớn hơn tổng thời gian job có thể chạy", () => {
      expect(STUCK_AFTER_SECONDS).toBe(6 * H);
      expect(STUCK_AFTER_SECONDS).toBeGreaterThan(3600 * (3 + 1));
    });

    it("ocr_processing và rule_checking quá hạn, không còn job -> failed với thông báo; job hợp lệ/mới thì giữ", async () => {
      const stuckOcr = await mk("ocr_processing", STUCK_AFTER_SECONDS + 60);
      const stuckRule = await mk("rule_checking", STUCK_AFTER_SECONDS + 60);
      const recent = await mk("ocr_processing", STUCK_AFTER_SECONDS - 600);
      const withJob = await mk("ocr_processing", STUCK_AFTER_SECONDS + 60);
      const classified = await mk("classified", STUCK_AFTER_SECONDS + 60);
      const boss = await getBoss(queue);
      await boss.send(OCR_QUEUE, { documentId: withJob }, { singletonKey: withJob });

      const r = await failStuckDocuments(deps);
      expect(r).toEqual({ failed: 2, skippedWithJob: 1 });
      for (const id of [stuckOcr, stuckRule]) {
        expect(await statusOf(id)).toMatchObject({ status: "failed", error: "Công việc OCR bị kẹt, vui lòng chạy lại" });
      }
      expect(await eventsOf(stuckOcr)).toContain("ocr_processing>failed");
      expect(await eventsOf(stuckRule)).toContain("rule_checking>failed");
      for (const id of [recent, withJob, classified]) expect((await statusOf(id)).status).not.toBe("failed");
    });

    it("job đã completed/failed cũ không được tính là còn job", async () => {
      const id = await mk("ocr_processing", STUCK_AFTER_SECONDS + 60);
      const boss = await getBoss(queue);
      const jobId = await boss.send(OCR_QUEUE, { documentId: id }, { singletonKey: id });
      await t.db.execute(sql`update pgboss.job set state = 'completed' where id = ${jobId}`);
      expect(await failStuckDocuments(deps)).toMatchObject({ failed: 1 });
      expect((await statusOf(id)).status).toBe("failed");
    });

    it("chạy lại lần hai không làm gì thêm", async () => {
      await mk("rule_checking", STUCK_AFTER_SECONDS + 60);
      expect(await failStuckDocuments(deps)).toMatchObject({ failed: 1 });
      expect(await failStuckDocuments(deps)).toEqual({ failed: 0, skippedWithJob: 0 });
    });
  });
});
