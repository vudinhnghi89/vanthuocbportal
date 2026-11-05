import { describe, expect, it } from "vitest";
import { formatDateTimeVN } from "@/lib/format-time";

describe("formatDateTimeVN", () => {
  it("luôn dùng giờ Việt Nam (UTC+7), 24 giờ, bất kể TZ của tiến trình", () => {
    expect(formatDateTimeVN("2026-01-01T00:00:00Z")).toBe("07:00:00 01/01/2026");
    // 17:30 UTC qua nửa đêm VN sang ngày hôm sau; "24:" không bao giờ xuất hiện (hour12 false)
    expect(formatDateTimeVN("2026-03-04T17:30:05Z")).toBe("00:30:05 05/03/2026");
    expect(formatDateTimeVN(new Date("2026-06-30T16:59:59Z"))).toBe("23:59:59 30/06/2026");
  });
  it("giá trị rỗng hoặc sai -> chuỗi rỗng", () => {
    expect(formatDateTimeVN(null)).toBe("");
    expect(formatDateTimeVN(undefined)).toBe("");
    expect(formatDateTimeVN("không phải ngày")).toBe("");
  });
  for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    it(`cùng kết quả khi TZ=${tz}`, () => {
      const prev = process.env.TZ;
      process.env.TZ = tz;
      try {
        expect(formatDateTimeVN("2026-01-01T00:00:00Z")).toBe("07:00:00 01/01/2026");
      } finally {
        if (prev === undefined) delete process.env.TZ;
        else process.env.TZ = prev;
      }
    });
  }
});
