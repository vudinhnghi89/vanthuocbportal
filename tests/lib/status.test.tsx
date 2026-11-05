// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

describe("src/lib/status (client-safe)", () => {
  it("imports without DATABASE_URL or db modules", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const m = await import("@/lib/status");
      expect(m.STATUSES).toContain("failed");
      expect(m.STATUS_LABELS.failed).toBe("Lỗi");
      for (const s of m.STATUSES) expect(m.STATUS_LABELS[s]).toBeTruthy();
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
  it("server/status re-exports the same values", async () => {
    const a = await import("@/lib/status");
    const b = await import("@/server/status");
    expect(b.STATUS_LABELS).toBe(a.STATUS_LABELS);
    expect(b.STATUSES).toBe(a.STATUSES);
  });
});
