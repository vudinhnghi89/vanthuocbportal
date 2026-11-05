import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP = path.resolve(__dirname, "../../src/app");
const ADMIN = path.join(APP, "admin");

function pages(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return pages(p);
    return e.name === "page.tsx" ? [p] : [];
  });
}

/** Thân hàm đầu tiên `export default async function ...`: câu lệnh đầu tiên phải là `await requireXPage()`. */
function firstStatement(src: string): string {
  const m = /export default async function \w+\([^)]*\)[^{]*\{([\s\S]*)/.exec(src.replace(/\n\s*/g, "\n"));
  if (!m) return "";
  return m[1].trim().split("\n")[0].trim();
}

describe("mọi page /admin gọi requireAdminPage() đầu tiên", () => {
  const files = pages(ADMIN).map((f) => path.relative(ADMIN, f).split(path.sep).join("/"));

  it("tìm thấy các page", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files)("%s", (rel) => {
    const src = fs.readFileSync(path.join(ADMIN, rel), "utf8");
    expect(src).toMatch(/export default async function/);
    expect(firstStatement(src), `${rel}: câu lệnh đầu tiên phải là await requireAdminPage()`).toBe(
      "await requireAdminPage();",
    );
  });
});

describe("page chi tiết văn bản gọi requireUserPage() đầu tiên", () => {
  it("documents/[id]", () => {
    const src = fs.readFileSync(path.join(APP, "(user)/documents/[id]/page.tsx"), "utf8");
    expect(firstStatement(src)).toMatch(/^(const \{ user \} = )?await requireUserPage\(\);$/);
  });
});
