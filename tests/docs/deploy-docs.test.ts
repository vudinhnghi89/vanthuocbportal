import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { ADMIN_PASSWORD_PLACEHOLDER } from "@/lib/credentials";

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
  // Biến của /etc/os-release trong lệnh cài Docker và biến của chính Dify (docker/.env của Dify, không thuộc repo này).
  const OS_VARS = new Set(["UBUNTU_CODENAME", "VERSION_CODENAME", "UPLOAD_FILE_SIZE_LIMIT", "NGINX_CLIENT_MAX_BODY_SIZE", "GUNICORN_TIMEOUT"]);
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

describe("lệnh kiểm tra giá trị mẫu trong docs/deploy.md", () => {
  const deploy = read("docs/deploy.md");
  const cmd = /^(grep -nE '\^\[A-Z_\]\+=\.\*change-me' \.env)/m.exec(deploy)?.[1];

  function grepOn(content: string): { status: number | null; out: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vtp-envdoc-"));
    try {
      fs.writeFileSync(path.join(dir, ".env"), content);
      const r = spawnSync("sh", ["-c", cmd!], { cwd: dir, encoding: "utf8" });
      return { status: r.status, out: r.stdout };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("placeholder trong .env.example khớp ADMIN_PASSWORD_PLACEHOLDER", () => {
    expect(read(".env.example")).toContain(`ADMIN_PASSWORD=${ADMIN_PASSWORD_PLACEHOLDER}`);
  });

  it("lệnh có trong tài liệu, khớp .env.example gốc và không khớp bản đã điền", () => {
    expect(cmd).toBeTruthy();
    const example = read(".env.example");
    const raw = grepOn(example);
    expect(raw.status).toBe(0);
    expect(raw.out).toContain("POSTGRES_PASSWORD=change-me");
    const filled = example.replace(/change-me/g, "a1b2c3d4e5f6a7b8c9d0");
    const ok = grepOn(filled);
    expect(ok.status).toBe(1);
    expect(ok.out).toBe("");
  });
});

describe("nội dung bắt buộc của tài liệu triển khai", () => {
  const deploy = read("docs/deploy.md");
  const readme = read("README.md");

  it("giới hạn Dify: UPLOAD_FILE_SIZE_LIMIT=50, nginx 50M, GUNICORN_TIMEOUT, MAX_FILE_BYTES, dòng sự cố 413, mục checklist", () => {
    for (const t of ["UPLOAD_FILE_SIZE_LIMIT=50", "NGINX_CLIENT_MAX_BODY_SIZE", "50M", "GUNICORN_TIMEOUT", "MAX_FILE_BYTES", "src/lib/upload-plan.ts"]) {
      expect(deploy, t).toContain(t);
    }
    expect(deploy).toMatch(/^\| `HTTP 413` từ Dify/m);
    expect(deploy).toMatch(/^7b\. \*\*Kiểm tra giới hạn Dify TRƯỚC/m);
    expect(read("src/lib/upload-plan.ts")).toContain("MAX_FILE_BYTES");
  });

  it("DATABASE_URL do Compose ghép: không còn trong .env.example, docs nêu POSTGRES_PASSWORD URL-safe", () => {
    expect(read(".env.example")).not.toMatch(/^DATABASE_URL=/m);
    expect(deploy).toContain("URL-safe");
    expect(deploy).not.toMatch(/^\| `DATABASE_URL` \|/m);
    expect(read("docker-compose.yml")).toContain("postgres://vanthu:${POSTGRES_PASSWORD");
  });

  it("HTTPS: --base-url và --insecure được nêu và script hỗ trợ", () => {
    expect(deploy).toContain("--base-url");
    expect(deploy).toContain("--insecure");
    const script = read("scripts/post-deploy-check.sh");
    expect(script).toContain("--base-url)");
    expect(script).toContain("--insecure)");
  });

  it("README sửa lời về phân loại thủ công và có mục 'Giới hạn đã biết' (README và deploy.md)", () => {
    expect(readme).not.toContain("xác nhận hoặc đổi đơn vị");
    expect(readme).toMatch(/^## Giới hạn đã biết/m);
    expect(deploy).toMatch(/^## 13\. Giới hạn đã biết/m);
    for (const doc of [readme, deploy]) {
      expect(doc).toContain("mọi người đăng nhập đều nhận mọi thông báo");
      expect(doc).toContain("không có rule \"mọi loại\"");
      expect(doc).toMatch(/Chỉ \*\*admin\*\* tạo\/sửa được rule/);
      expect(doc).toContain("không đổi hướng được");
    }
  });
});
