// Rate limit đăng nhập: 5 lần/phút/IP, lưu trong bộ nhớ tiến trình.
// Chấp nhận được vì chỉ chạy một instance web (xem spec §8). Nếu scale ngang
// nhiều instance thì phải chuyển sang kho dùng chung (Postgres/Redis).
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

const hits = new Map<string, number[]>();

/** Ghi nhận một lần thử; trả false nếu IP đã vượt hạn mức (caller trả 429). */
export function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  }
  return true;
}

export function resetLoginRateLimit(): void {
  hits.clear();
}
