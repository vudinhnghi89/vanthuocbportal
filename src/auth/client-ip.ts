/** Caddy đặt X-Forwarded-For; lấy phần tử cuối do proxy tin cậy thêm vào. */
export function getClientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}
