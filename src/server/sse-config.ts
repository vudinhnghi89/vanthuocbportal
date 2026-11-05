export const DEFAULT_REVALIDATE_MS = 5 * 60_000;
export const MIN_REVALIDATE_MS = 1000;

/**
 * Chu kỳ kiểm tra lại phiên của luồng SSE. `SSE_REVALIDATE_MS` chỉ để rút ngắn trong dev/test:
 * không dưới 1000 ms (tránh truy vấn DB dồn dập) và bị bỏ qua hoàn toàn ở production.
 */
export function resolveRevalidateMs(env: { NODE_ENV?: string; SSE_REVALIDATE_MS?: string } = process.env): number {
  if (env.NODE_ENV === "production") return DEFAULT_REVALIDATE_MS;
  const n = Number(env.SSE_REVALIDATE_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REVALIDATE_MS;
  return Math.max(MIN_REVALIDATE_MS, n);
}
