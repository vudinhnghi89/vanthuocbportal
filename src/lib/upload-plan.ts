// Logic thuần (không DOM, không React) cho vùng kéo thả upload.
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 10;
/** Biên an toàn phía client, thấp hơn trần 200 MiB của máy chủ. */
export const MAX_REQUEST_BYTES = 150 * 1024 * 1024;

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: "not_pdf" | "empty" | "too_large"; message: string };

const TOLERATED_MIME = new Set(["", "application/pdf", "application/octet-stream", "application/x-pdf"]);

/** Máy chủ mới kiểm tra magic bytes; MIME của trình duyệt không đáng tin nên chỉ loại các MIME rõ ràng sai. */
export function validateFile(file: { name: string; size: number; type?: string }): ValidationResult {
  const mime = (file.type ?? "").toLowerCase();
  if (!/\.pdf$/i.test(file.name) || !TOLERATED_MIME.has(mime)) {
    return { ok: false, reason: "not_pdf", message: "Chỉ chấp nhận tệp PDF (.pdf)" };
  }
  if (file.size === 0) return { ok: false, reason: "empty", message: "Tệp rỗng" };
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, reason: "too_large", message: "Tệp vượt quá 50 MB" };
  }
  return { ok: true };
}

/** Chia tham lam theo thứ tự: mỗi lô tối đa 10 tệp và 150 MiB. */
export function planBatches<T extends { size: number }>(files: T[]): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const f of files) {
    if (cur.length > 0 && (cur.length >= MAX_FILES_PER_REQUEST || bytes + f.size > MAX_REQUEST_BYTES)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(f);
    bytes += f.size;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

export type ServerOutcome = { kind: "http"; status: number; body: unknown } | { kind: "network" };
export type FileOutcome = { ok: true } | { ok: false; message: string };

const HTTP_MESSAGES: Record<number, string> = {
  401: "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại",
  411: "Không xác định được kích thước yêu cầu, vui lòng thử lại",
  413: "Dung lượng vượt quá giới hạn cho phép",
  400: "Yêu cầu không hợp lệ",
};
const NETWORK_MESSAGE = "Mất kết nối mạng, vui lòng thử lại";
const SERVER_MESSAGE = "Lỗi máy chủ, vui lòng thử lại sau";
const MISSING_MESSAGE = "Máy chủ không trả kết quả cho tệp này";

type RawResult = { ok?: unknown; error?: unknown };

/** Ánh xạ phản hồi của máy chủ (theo thứ tự tệp trong lô) sang trạng thái từng tệp. */
export function describeServerResult(files: { name: string }[], outcome: ServerOutcome): FileOutcome[] {
  const all = (message: string): FileOutcome[] => files.map(() => ({ ok: false, message }));
  if (outcome.kind === "network") return all(NETWORK_MESSAGE);
  const body = outcome.body as { results?: unknown } | null;
  const results = body && Array.isArray(body.results) ? (body.results as RawResult[]) : null;
  if (results && (outcome.status === 201 || outcome.status === 400)) {
    return files.map((_, i) => {
      const r = results[i];
      if (!r) return { ok: false, message: MISSING_MESSAGE };
      if (r.ok === true) return { ok: true };
      return { ok: false, message: typeof r.error === "string" && r.error ? r.error : MISSING_MESSAGE };
    });
  }
  if (HTTP_MESSAGES[outcome.status]) return all(HTTP_MESSAGES[outcome.status]);
  if (outcome.status >= 500) return all(SERVER_MESSAGE);
  return all(`Tải lên thất bại (HTTP ${outcome.status})`);
}
