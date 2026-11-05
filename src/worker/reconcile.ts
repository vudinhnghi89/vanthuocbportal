import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import { documents } from "@/db/schema";
import type { DbLike } from "@/server/status";
import { InvalidTransitionError, DocumentNotFoundError, transition } from "@/server/status";
import { OCR_DEAD_QUEUE, OCR_EXPIRE_SECONDS, OCR_QUEUE, OCR_RETRY_LIMIT, enqueueOcr, getBoss, type QueueOptions } from "./queue";

export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const STALE_SECONDS = 60;
const MAX_PER_RUN = 200;

/**
 * Văn bản `ocr_processing`/`rule_checking` quá lâu mà không còn job nào: một job chạy tối đa
 * expire (1 giờ) x (retryLimit + 1) = 4 giờ, cộng 2 giờ dự phòng (hàng chết, lệch đồng hồ) = 6 giờ.
 */
export const STUCK_AFTER_SECONDS = OCR_EXPIRE_SECONDS * (OCR_RETRY_LIMIT + 1) + 2 * 3600;
export const STUCK_MESSAGE = "Công việc OCR bị kẹt, vui lòng chạy lại";

export type ReconcileOptions = {
  db?: DbLike;
  /** Tùy chọn hàng đợi (test). */
  queue?: QueueOptions;
  enqueue?: (documentId: string) => Promise<string | null>;
  staleSeconds?: number;
  limit?: number;
};
export type ReconcileResult = { enqueued: number; alreadyQueued: number; failed: number };

/**
 * Văn bản `queued` quá 60 giây mà có thể chưa có job (enqueue lỗi sau commit khi tải lên/chạy lại,
 * hoặc send đã commit nhưng ném lỗi): đẩy lại. enqueueOcr idempotent theo singletonKey nên không tạo job trùng.
 */
export async function reconcileQueuedDocuments(options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const db = options.db ?? defaultDb;
  const enqueue = options.enqueue ?? ((id: string) => enqueueOcr(id, options.queue));
  const stale = options.staleSeconds ?? STALE_SECONDS;
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.status, "queued"), sql`${documents.updatedAt} < now() - make_interval(secs => ${stale})`))
    .orderBy(asc(documents.updatedAt))
    .limit(options.limit ?? MAX_PER_RUN);

  const result: ReconcileResult = { enqueued: 0, alreadyQueued: 0, failed: 0 };
  for (const { id } of rows) {
    try {
      if ((await enqueue(id)) === null) result.alreadyQueued++;
      else result.enqueued++;
    } catch (e) {
      result.failed++;
      // Chỉ log tên lớp lỗi: thông báo có thể chứa chuỗi kết nối.
      console.error(`[reconcile] ${id}: enqueue lỗi (${(e as { name?: string } | null)?.name ?? "Error"})`);
    }
  }
  return result;
}

export type StuckResult = { failed: number; skippedWithJob: number };
const LIVE_JOB_STATES = new Set(["created", "retry", "active"]);

/**
 * Văn bản dở dang quá STUCK_AFTER_SECONDS và không có job created/retry/active (ở `ocr` lẫn `ocr_dead`)
 * -> failed (ocr_processing/rule_checking -> failed là cạnh hợp lệ). Người dùng bấm "Chạy lại" để làm tiếp.
 */
export async function failStuckDocuments(options: ReconcileOptions & { stuckAfterSeconds?: number } = {}): Promise<StuckResult> {
  const db = options.db ?? defaultDb;
  const after = options.stuckAfterSeconds ?? STUCK_AFTER_SECONDS;
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        inArray(documents.status, ["ocr_processing", "rule_checking"]),
        sql`${documents.updatedAt} < now() - make_interval(secs => ${after})`,
      ),
    )
    .orderBy(asc(documents.updatedAt))
    .limit(options.limit ?? MAX_PER_RUN);

  const result: StuckResult = { failed: 0, skippedWithJob: 0 };
  if (rows.length === 0) return result;
  const boss = await getBoss(options.queue);
  for (const { id } of rows) {
    try {
      const jobs = [...(await boss.findJobs(OCR_QUEUE, { key: id })), ...(await boss.findJobs(OCR_DEAD_QUEUE, { key: id }))];
      if (jobs.some((j) => LIVE_JOB_STATES.has(j.state))) {
        result.skippedWithJob++;
        continue;
      }
      await transition(id, "failed", { error: STUCK_MESSAGE, note: "Văn bản bị kẹt, không còn job" }, db);
      result.failed++;
    } catch (e) {
      if (e instanceof InvalidTransitionError || e instanceof DocumentNotFoundError) continue; // đã được xử lý hướng khác
      console.error(`[reconcile] ${id}: quét văn bản kẹt lỗi (${(e as { name?: string } | null)?.name ?? "Error"})`);
    }
  }
  return result;
}

/** Chạy ngay rồi định kỳ; lỗi chỉ log tên lớp, không bao giờ làm sập worker. stop() hủy bộ hẹn giờ. */
export function startReconciler(
  options: { run?: () => Promise<ReconcileResult>; intervalMs?: number } = {},
): { stop(): void } {
  const run =
    options.run ??
    (async () => {
      const queued = await reconcileQueuedDocuments();
      const stuck = await failStuckDocuments().catch((e) => {
        console.error(`[reconcile] quét văn bản kẹt lỗi (${(e as { name?: string } | null)?.name ?? "Error"})`);
        return { failed: 0, skippedWithJob: 0 };
      });
      if (stuck.failed) console.log(`[reconcile] stuck failed=${stuck.failed}`);
      return queued;
    });
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await run();
      if (r.enqueued || r.failed) console.log(`[reconcile] enqueued=${r.enqueued} already=${r.alreadyQueued} failed=${r.failed}`);
    } catch (e) {
      console.error(`[reconcile] lỗi (${(e as { name?: string } | null)?.name ?? "Error"})`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs ?? RECONCILE_INTERVAL_MS);
  return { stop: () => clearInterval(timer) };
}
