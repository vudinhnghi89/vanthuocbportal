const dateTime = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  hour12: false,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Giờ Việt Nam (UTC+7) cố định, không phụ thuộc múi giờ của máy chủ hay trình duyệt (tránh lệch hydration). */
export function formatDateTimeVN(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return "";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : dateTime.format(d);
}
