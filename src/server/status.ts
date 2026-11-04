import { eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import { documentEvents, documents, DOCUMENT_STATUSES } from "@/db/schema";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type * as schema from "@/db/schema";

export type Status = (typeof DOCUMENT_STATUSES)[number];
export const STATUSES: readonly Status[] = DOCUMENT_STATUSES;

export const STATUS_LABELS: Record<Status, string> = {
  queued: "Hàng đợi",
  ocr_processing: "Đang xử lý OCR",
  rule_checking: "Đang tra soát rule",
  classified: "Hoàn tất phân loại",
  unit_processing: "Đơn vị đang xử lý",
  done: "Xong",
  failed: "Lỗi",
};

export const ALLOWED_TRANSITIONS: Record<Status, readonly Status[]> = {
  queued: ["ocr_processing"],
  ocr_processing: ["rule_checking", "failed"],
  rule_checking: ["classified", "failed"],
  classified: ["unit_processing"],
  unit_processing: ["done"],
  done: [],
  failed: ["queued"],
};

/** Kênh Postgres NOTIFY; web process sẽ LISTEN (T-6.4). Payload: {documentId, from, to}. */
export const DOC_EVENTS_CHANNEL = "doc_events";
const MAX_ERROR_LEN = 2000;

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: Status,
    public readonly to: Status,
  ) {
    super(`Không thể chuyển trạng thái từ ${from} sang ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class DocumentNotFoundError extends Error {
  constructor(public readonly documentId: string) {
    super("Không tìm thấy văn bản");
    this.name = "DocumentNotFoundError";
  }
}

/** Cơ sở chung của db và tx (PgTransaction extends PgDatabase): truyền `tx` để ghép chung giao dịch với caller. */
export type DbLike = PgDatabase<NodePgQueryResultHKT, typeof schema>;
export type TransitionOpts = { actorId?: number | null; note?: string; error?: string };

/**
 * Chuyển trạng thái trong một giao dịch (khóa dòng FOR UPDATE). Cùng trạng thái đích -> no-op
 * (changed=false, không ghi event, không notify) để an toàn khi job bị giao lại.
 */
export async function transition(
  documentId: string,
  to: Status,
  opts: TransitionOpts = {},
  db: DbLike = defaultDb,
): Promise<{ changed: boolean; from: Status; to: Status }> {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ status: documents.status })
      .from(documents)
      .where(eq(documents.id, documentId))
      .for("update");
    if (!doc) throw new DocumentNotFoundError(documentId);
    const from = doc.status;
    if (from === to) return { changed: false, from, to };
    if (!ALLOWED_TRANSITIONS[from].includes(to)) throw new InvalidTransitionError(from, to);

    const patch: Partial<typeof documents.$inferInsert> = { status: to, updatedAt: sql`clock_timestamp()` as never };
    if (to === "failed") patch.error = (opts.error ?? "").slice(0, MAX_ERROR_LEN) || null;
    else if (from === "failed") patch.error = null;
    await tx.update(documents).set(patch).where(eq(documents.id, documentId));

    await tx.insert(documentEvents).values({
      documentId,
      fromStatus: from,
      toStatus: to,
      actorId: opts.actorId ?? null,
      note: opts.note ?? null,
      at: sql`clock_timestamp()` as never,
    });
    // Chỉ được giao cho listener khi giao dịch commit.
    await tx.execute(sql`select pg_notify(${DOC_EVENTS_CHANNEL}, ${JSON.stringify({ documentId, from, to })})`);
    return { changed: true, from, to };
  });
}
