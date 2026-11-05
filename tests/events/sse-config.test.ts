import { describe, expect, it } from "vitest";
import { MIN_REVALIDATE_MS, DEFAULT_REVALIDATE_MS, resolveRevalidateMs } from "@/server/sse-config";

describe("resolveRevalidateMs", () => {
  it("mặc định 5 phút khi không đặt hoặc không hợp lệ", () => {
    for (const v of [undefined, "", "abc", "0", "-5", "NaN", "Infinity"]) {
      expect(resolveRevalidateMs({ NODE_ENV: "development", SSE_REVALIDATE_MS: v })).toBe(DEFAULT_REVALIDATE_MS);
    }
    expect(DEFAULT_REVALIDATE_MS).toBe(300_000);
  });
  it("ngoài production: dùng giá trị đặt nhưng không dưới 1000 ms", () => {
    expect(resolveRevalidateMs({ NODE_ENV: "test", SSE_REVALIDATE_MS: "3000" })).toBe(3000);
    expect(resolveRevalidateMs({ NODE_ENV: "test", SSE_REVALIDATE_MS: "10" })).toBe(MIN_REVALIDATE_MS);
    expect(MIN_REVALIDATE_MS).toBe(1000);
  });
  it("production: bỏ qua biến, dùng mặc định", () => {
    expect(resolveRevalidateMs({ NODE_ENV: "production", SSE_REVALIDATE_MS: "1000" })).toBe(DEFAULT_REVALIDATE_MS);
    expect(resolveRevalidateMs({ NODE_ENV: "production", SSE_REVALIDATE_MS: "999999999" })).toBe(DEFAULT_REVALIDATE_MS);
  });
});
