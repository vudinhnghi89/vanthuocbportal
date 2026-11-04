import { describe, expect, it } from "vitest";
import { dbSuiteMode } from "./require-db";

describe("dbSuiteMode", () => {
  it("chạy khi có DATABASE_URL", () => {
    expect(dbSuiteMode({ DATABASE_URL: "postgres://x", CI: "true" })).toBe("run");
  });
  it("skip local khi thiếu DATABASE_URL", () => {
    expect(dbSuiteMode({})).toBe("skip");
  });
  it("fail trong CI khi thiếu DATABASE_URL", () => {
    expect(dbSuiteMode({ CI: "true" })).toBe("fail");
  });
});
