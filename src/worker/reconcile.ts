import { and, asc, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import { documents } from "@/db/schema";
import type { DbLike } from "@/server/status";
import { enqueueOcr, type QueueOptions } from "./queue";

export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const STALE_SECONDS = 60;
const MAX_PER_RUN = 200;

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

/** Chạy ngay rồi định kỳ; lỗi chỉ log tên lớp, không bao giờ làm sập worker. stop() hủy bộ hẹn giờ. */
export function startReconciler(
  options: { run?: () => Promise<ReconcileResult>; intervalMs?: number } = {},
): { stop(): void } {
  const run = options.run ?? (() => reconcileQueuedDocuments());
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
