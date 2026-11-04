import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLoginRateLimit, resetLoginRateLimit } from "@/auth/rate-limit";

describe("checkLoginRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLoginRateLimit();
  });
  afterEach(() => vi.useRealTimers());

  it("5 lần đầu được phép, lần thứ 6 trong 1 phút bị chặn", () => {
    for (let i = 0; i < 5; i++) expect(checkLoginRateLimit("1.1.1.1")).toBe(true);
    expect(checkLoginRateLimit("1.1.1.1")).toBe(false);
  });

  it("IP khác không bị ảnh hưởng", () => {
    for (let i = 0; i < 6; i++) checkLoginRateLimit("1.1.1.1");
    expect(checkLoginRateLimit("2.2.2.2")).toBe(true);
  });

  it("được phép lại sau 1 phút", () => {
    for (let i = 0; i < 6; i++) checkLoginRateLimit("1.1.1.1");
    vi.advanceTimersByTime(60_001);
    expect(checkLoginRateLimit("1.1.1.1")).toBe(true);
  });
});
