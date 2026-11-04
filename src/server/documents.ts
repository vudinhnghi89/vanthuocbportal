import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import { documentEvents, documents } from "@/db/schema";
import { enqueueOcr } from "@/worker/queue";
import { deletePdf, savePdf } from "./storage";
import type { DbLike } from "./status";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 10;
/** Trần tổng kích thước yêu cầu khai báo trong Content-Length (giới hạn bộ nhớ khi parse multipart). */
export const MAX_REQUEST_BYTES = 200 * 1024 * 1024;

export type UploadErrorCode = "bad_extension" | "empty" | "too_large" | "not_pdf" | "internal";
const MESSAGES: Record<UploadErrorCode, string> = {
  bad_extension: "Chỉ chấp nhận tệp có đuôi .pdf",
  empty: "Tệp rỗng",
  too_large: "Tệp vượt quá 50 MB",
  not_pdf: "Tệp không phải PDF hợp lệ",
  internal: "Không thể xử lý tệp, vui lòng thử lại",
};

export type UploadResult =
  | { filename: string; ok: true; id: string; status: "queued" }
  | { filename: string; ok: false; error: string; code: UploadErrorCode };

const fail = (filename: string, code: UploadErrorCode): UploadResult => ({
  filename,
  ok: false,
  error: MESSAGES[code],
  code,
});

/** Chỉ giữ tên tệp (basename): bỏ thư mục, `..`, dấu `\`, ký tự điều khiển/NUL; tối đa 255 ký tự. */
export function sanitizeFilename(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "");
  const base = cleaned.split(/[\\/]+/).filter(Boolean).pop()?.trim() ?? "";
  if (!base || base === "." || base === "..") return "document.pdf";
  if (base.length <= 255) return base;
  const ext = /\.pdf$/i.test(base) ? base.slice(-4) : "";
  return base.slice(0, 255 - ext.length) + ext;
}

export const hasPdfMagic = (buf: Uint8Array): boolean =>
  buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d;

/** Kiểm tra trước khi đọc nội dung (dựa tên và kích thước đã biết). */
export function precheckUpload(filename: string, size: number): UploadErrorCode | null {
  if (!/\.pdf$/i.test(filename)) return "bad_extension";
  if (size === 0) return "empty";
  if (size > MAX_FILE_BYTES) return "too_large";
  return null;
}

/** Ghi dòng documents (queued) và event khởi tạo trong cùng một giao dịch. */
export async function createDocument(
  input: { filename: string; pdfPath: string; uploadedBy: number },
  db: DbLike = defaultDb,
): Promise<{ id: string; status: "queued" }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(documents)
      .values({ filename: input.filename, pdfPath: input.pdfPath, uploadedBy: input.uploadedBy, status: "queued" })
      .returning({ id: documents.id });
    await tx
      .insert(documentEvents)
      .values({ documentId: row.id, fromStatus: null, toStatus: "queued", actorId: input.uploadedBy });
    return { id: row.id, status: "queued" as const };
  });
}

/**
 * Một tệp tải lên: lưu file -> tạo dòng -> đẩy job OCR. Bất kỳ bước nào lỗi thì dọn dẹp
 * (dòng + file) và trả lỗi chung, không lộ chi tiết nội bộ.
 */
export async function createDocumentFromUpload(
  input: { filename: string; buffer: Buffer; uploadedBy: number },
  db: DbLike = defaultDb,
): Promise<UploadResult> {
  const filename = sanitizeFilename(input.filename);
  let pdfPath: string | null = null;
  let id: string | null = null;
  try {
    pdfPath = await savePdf(input.buffer);
    ({ id } = await createDocument({ filename, pdfPath, uploadedBy: input.uploadedBy }, db));
    if ((await enqueueOcr(id)) === null) throw new Error("Không tạo được job OCR");
    return { filename, ok: true, id, status: "queued" };
  } catch (e) {
    console.error("[upload] xử lý tệp thất bại:", e instanceof Error ? e.message : "lỗi không rõ");
    if (id) await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
    if (pdfPath) await deletePdf(pdfPath).catch(() => {});
    return fail(filename, "internal");
  }
}

export { fail as uploadFailure };
