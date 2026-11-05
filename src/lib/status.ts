// Module thuần (không import db/server): dùng được cả ở client component.
export const DOCUMENT_STATUSES = [
  "queued", "ocr_processing", "rule_checking", "classified", "unit_processing", "done", "failed",
] as const;

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
