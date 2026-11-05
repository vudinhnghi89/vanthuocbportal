import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/app/globals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Top-level rule selectors (also inside @media blocks), without declarations. */
function selectors(src: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(...m[1].split(",").map((x) => x.trim()));
  return out.filter((x) => x && !x.startsWith("@"));
}

describe("globals.css scoping", () => {
  it("has no unscoped bare element selectors (restyling /login and /admin)", () => {
    const banned = /^(a|button|h1|h2|h3|table|th|td|ul|ol|li|p|input|select|label|form|nav|main|header)(:[\w-]+)?$/;
    const bad = selectors(css).filter((s) => banned.test(s));
    expect(bad).toEqual([]);
  });
  it("defines badge colours as variables for light and dark", () => {
    expect(css).not.toMatch(/\.badge--[a-z]+\s*\{[^}]*#[0-9a-f]{3,6}/i);
    expect((css.match(/--badge-failed:/g) ?? []).length).toBe(2);
    expect((css.match(/--badge-manual:/g) ?? []).length).toBe(2);
  });
  it("uses no hard-coded hex colours outside the token blocks", () => {
    const outside = css.replace(/:root\s*\{[^}]*\}/g, "");
    expect(outside).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
