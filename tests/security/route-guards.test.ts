import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const API = path.resolve(__dirname, "../../src/app/api");

function routes(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return routes(p);
    return e.name === "route.ts" ? [p] : [];
  });
}

/** Route cố ý công khai (proxyDecision cũng cho qua): đăng nhập NextAuth và health check. */
const PUBLIC_ALLOW_LIST = new Set(["auth/[...nextauth]/route.ts", "health/route.ts"]);

describe("mọi route API đều có guard", () => {
  const files = routes(API).map((f) => path.relative(API, f).split(path.sep).join("/"));

  it("tìm thấy các route", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(files)("%s", (rel) => {
    const src = fs.readFileSync(path.join(API, rel), "utf8");
    if (PUBLIC_ALLOW_LIST.has(rel)) return;
    const guarded = /\brequire(User|Admin)\(/.test(src);
    expect(guarded, `${rel} không gọi requireUser()/requireAdmin()`).toBe(true);
    if (rel.startsWith("admin/")) {
      expect(/\brequireAdmin\(/.test(src), `${rel} thuộc /admin nên phải dùng requireAdmin()`).toBe(true);
    }
  });

  it("allow-list không chứa route đã bị xóa", () => {
    for (const a of PUBLIC_ALLOW_LIST) expect(files).toContain(a);
  });
});
