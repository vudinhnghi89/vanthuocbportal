// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const listRuleAudit = vi.fn();
vi.mock("@/auth/page-guard", () => ({ requireAdminPage: () => Promise.resolve() }));
vi.mock("@/server/rules", () => ({ listRuleAudit: (...a: unknown[]) => listRuleAudit(...a) }));
vi.mock("next/link", () => ({ default: () => null }));

import RuleHistoryPage from "@/app/admin/rules/history/page";
import { parseRuleIdParam } from "@/lib/rule-id-param";

const run = async (ruleId?: string | string[]) => JSON.stringify(await RuleHistoryPage({ searchParams: Promise.resolve({ ruleId }) }));

describe("parseRuleIdParam", () => {
  it.each([
    ["1", 1],
    ["2147483647", 2147483647],
  ])("%s hợp lệ", (v, id) => expect(parseRuleIdParam(v)).toEqual({ id, invalid: false }));
  it.each(["2147483648", "99999999999999999999", "0", "-1", "1.5", "abc", "1e3", " 1"])("%s không hợp lệ", (v) =>
    expect(parseRuleIdParam(v)).toEqual({ invalid: true }),
  );
  it("không có tham số -> không lọc, không báo lỗi", () => {
    expect(parseRuleIdParam(undefined)).toEqual({ invalid: false });
    expect(parseRuleIdParam("")).toEqual({ invalid: false });
  });
});

describe("admin rule history ?ruleId", () => {
  beforeEach(() => listRuleAudit.mockReset().mockResolvedValue([]));
  it("ruleId vượt int4: không truy vấn theo id (không 500), hiển thị thông báo", async () => {
    const out = await run("2147483648");
    expect(listRuleAudit).toHaveBeenCalledWith(undefined);
    expect(out).toContain("không hợp lệ");
  });
  it("ruleId hợp lệ: lọc theo id, không có thông báo", async () => {
    const out = await run("12");
    expect(listRuleAudit).toHaveBeenCalledWith(12);
    expect(out).not.toContain("không hợp lệ");
  });
});
