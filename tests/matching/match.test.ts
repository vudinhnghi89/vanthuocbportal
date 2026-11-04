import { describe, expect, it } from "vitest";
import { matchRules } from "@/matching/match";
import type { Alias } from "@/matching/normalize";
import type { Rule } from "@/server/rules";

let seq = 0;
function rule(p: Partial<Rule> = {}): Rule {
  seq += 1;
  return {
    id: seq,
    issuer: "Bộ Y tế",
    docType: "Công văn",
    title: "t",
    summary: "",
    mainUnitId: 1,
    infoUnitId: null,
    priority: 0,
    active: true,
    updatedAt: new Date(0),
    ...p,
  } as Rule;
}
const ex = { issuer: "Bộ Y tế", docType: "Công văn" };

describe("matchRules", () => {
  it("0 rules -> []", () => expect(matchRules(ex, [], [])).toEqual([]));
  it("exactly 1 rule", () => {
    const r = rule();
    expect(matchRules(ex, [r], [])).toEqual([r]);
  });
  it("orders by priority desc then id asc", () => {
    const a = rule({ id: 30, priority: 1 });
    const b = rule({ id: 20, priority: 5 });
    const c = rule({ id: 10, priority: 5 });
    const d = rule({ id: 40, priority: -1 });
    expect(matchRules(ex, [a, d, b, c], []).map((r) => r.id)).toEqual([10, 20, 30, 40]);
  });
  it("ignores inactive rules even if only match", () => {
    expect(matchRules(ex, [rule({ active: false })], [])).toEqual([]);
  });
  it("issuer matches, docType differs -> []", () => {
    expect(matchRules({ ...ex, docType: "Quyết định" }, [rule()], [])).toEqual([]);
  });
  it("docType matches, issuer differs -> []", () => {
    expect(matchRules({ ...ex, issuer: "Bộ Tài chính" }, [rule()], [])).toEqual([]);
  });
  it.each([undefined, null, "", "  ", " ... ", "-/ "])("empty issuer %j -> []", (issuer) => {
    expect(matchRules({ issuer, docType: "Công văn" }, [rule()], [])).toEqual([]);
  });
  it.each([undefined, null, "", " . "])("empty docType %j -> []", (docType) => {
    expect(matchRules({ issuer: "Bộ Y tế", docType }, [rule()], [])).toEqual([]);
  });
  it("missing fields entirely -> []", () => {
    expect(matchRules({}, [rule()], [])).toEqual([]);
  });
  it("diacritics/case/whitespace variants", () => {
    const r1 = rule({ issuer: "bo y te", docType: "cong van" });
    const r2 = rule({ issuer: "Bộ Y tế", docType: "Công văn" });
    expect(matchRules({ issuer: "Bộ Y Tế ", docType: "CÔNG VĂN" }, [r1, r2], [])).toHaveLength(2);
  });
  const aliases: Alias[] = [{ alias: "BYT", canonicalIssuer: "Bộ Y tế" }];
  it("alias on extracted side", () => {
    const r = rule();
    expect(matchRules({ issuer: "BYT", docType: "Công văn" }, [r], aliases)).toEqual([r]);
  });
  it("alias on rule side", () => {
    const r = rule({ issuer: "BYT" });
    expect(matchRules(ex, [r], aliases)).toEqual([r]);
  });
  it("rule with empty-normalizing issuer/docType never matches empty extraction", () => {
    const rs = [rule({ issuer: " ... " }), rule({ docType: "--" }), rule({ issuer: "", docType: "" })];
    expect(matchRules({ issuer: "", docType: "" }, rs, [])).toEqual([]);
    expect(matchRules({ issuer: "!!", docType: "??" }, rs, [])).toEqual([]);
    expect(matchRules(ex, rs, [])).toEqual([]);
  });
  it("does not mutate inputs", () => {
    const rs = [rule({ priority: 1 }), rule({ priority: 2 })];
    const al: Alias[] = [{ alias: "BYT", canonicalIssuer: "Bộ Y tế" }];
    const e = { ...ex };
    const rsCopy = structuredClone(rs);
    const alCopy = structuredClone(al);
    const out = matchRules(e, rs, al);
    expect(out).not.toBe(rs);
    expect(rs).toEqual(rsCopy);
    expect(al).toEqual(alCopy);
    expect(e).toEqual(ex);
  });
  it("2000 rules runs fast", () => {
    const rs = Array.from({ length: 2000 }, (_, i) => rule({ issuer: `Cơ quan ${i}`, docType: "Công văn" }));
    const al: Alias[] = Array.from({ length: 200 }, (_, i) => ({ alias: `A${i}`, canonicalIssuer: `Cơ quan ${i}` }));
    const t = performance.now();
    const out = matchRules({ issuer: "A7", docType: "Công văn" }, rs, al);
    expect(out).toHaveLength(1);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
