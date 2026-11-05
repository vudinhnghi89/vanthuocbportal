import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const DOCS = ["docs/deploy.md", "README.md", "docs/backup.md"];
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));
const pkgScripts = Object.keys((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts);

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    return e.isDirectory() ? walk(rel) : [rel];
  });
}

function uniq(re: RegExp, text: string, group = 1): string[] {
  return [...new Set([...text.matchAll(re)].map((m) => m[group]))];
}

describe.each(DOCS)("%s tham chiếu tới những thứ có thật", (doc) => {
  const text = read(doc);

  it("scripts/*.sh tồn tại", () => {
    for (const s of uniq(/\bscripts\/[A-Za-z0-9._-]+\.sh\b/g, text, 0)) expect(exists(s), s).toBe(true);
  });

  it("npm run <x> có trong package.json", () => {
    for (const s of uniq(/\bnpm run ([A-Za-z0-9:_-]+)/g, text)) expect(pkgScripts, s).toContain(s);
  });

  it("file docker-compose*.yml, Caddyfile, .env.example và docs/*.md tồn tại", () => {
    // Bỏ qua tên file ví dụ do người đọc tự tạo (docker-compose.hostdify.yml).
    const SAMPLE = new Set(["docker-compose.hostdify.yml"]);
    for (const f of uniq(/\bdocker-compose(?:\.[a-z]+)?\.yml\b/g, text, 0)) {
      if (!SAMPLE.has(f)) expect(exists(f), f).toBe(true);
    }
    if (/Caddyfile/.test(text)) expect(exists("Caddyfile")).toBe(true);
    if (/\.env\.example/.test(text)) expect(exists(".env.example")).toBe(true);
    for (const f of uniq(/\bdocs\/[A-Za-z0-9._\/-]+\.md\b/g, text, 0)) expect(exists(f), f).toBe(true);
  });
});

describe("biến môi trường trong docs/deploy.md", () => {
  // Kho tìm: .env.example, mã nguồn, script, compose, Dockerfile, Caddyfile.
  const corpus = [
    ".env.example",
    "Dockerfile",
    "Caddyfile",
    "docker-compose.yml",
    "docker-compose.dify.yml",
    ...walk("src"),
    ...walk("scripts"),
  ]
    .map(read)
    .join("\n");
  const deploy = read("docs/deploy.md");

  // `NAME=` ở đầu dòng hoặc trong mã (kể cả `NAME=...` đặt sau khoảng trắng/dấu nháy) và `${NAME`.
  const OS_VARS = new Set(["UBUNTU_CODENAME", "VERSION_CODENAME"]); // biến của /etc/os-release trong lệnh cài Docker
  const names = new Set([
    ...uniq(/(?:^|[\s`'"(])([A-Z][A-Z0-9_]{2,})=/gm, deploy),
    ...uniq(/\$\{([A-Z][A-Z0-9_]+)/g, deploy),
    ...uniq(/`([A-Z][A-Z0-9]*_[A-Z0-9_]+)`/g, deploy), // `TÊN_BIẾN` trong văn xuôi / bảng
  ].filter((n) => !OS_VARS.has(n)));

  it("tìm thấy các biến chính", () => {
    for (const n of ["APP_SECRET", "AUTH_URL", "DATABASE_URL", "DIFY_NETWORK", "ADMIN_USERNAME"]) expect(names, n).toContain(n);
  });

  it("mỗi biến được nêu đều có trong .env.example hoặc mã nguồn", () => {
    for (const n of names) expect(corpus.includes(n), `${n} không có trong .env.example/src/scripts/compose`).toBe(true);
  });

  it("các biến bắt buộc của compose đều có trong .env.example", () => {
    const compose = read("docker-compose.yml");
    const example = read(".env.example");
    for (const n of uniq(/\$\{([A-Z][A-Z0-9_]+):\?/g, compose)) expect(example, n).toMatch(new RegExp(`^${n}=`, "m"));
  });
});
