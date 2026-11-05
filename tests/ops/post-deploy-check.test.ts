import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/post-deploy-check.sh");

const DOCKER_STUB = `#!/usr/bin/env bash
args="$*"
case "$args" in
  "compose ps -a --format"*) cat "$STUB_DIR/ps.txt" ;;
  "compose exec -T web sh -c"*) exit "\${STUB_WEB_WRITE:-0}" ;;
  "compose exec -T worker sh -c"*) exit "\${STUB_WORKER_WRITE:-0}" ;;
  "compose exec -T worker node -e"*) exit "\${STUB_GATEWAY:-0}" ;;
  "compose exec -T postgres sh -c"*) printf '%s\\n' "\${STUB_PGBOSS-1}" ;;
  "compose port postgres 5432") printf '%s\\n' "\${STUB_PGPORT-}" ;;
  "info --format"*) echo "" ;;
  *) echo "docker stub: lệnh lạ: $args" >&2; exit 99 ;;
esac
`;

const CURL_STUB = `#!/usr/bin/env bash
out=""; hdr=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; -D) hdr="$2"; shift 2 ;; -w|-m) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
code=200; body=''
case "$url" in
  */api/health) code="\${STUB_HEALTH_CODE:-200}"; body='{"ok":true}' ;;
  */api/documents) code="\${STUB_DOCS_CODE:-401}"; body='{"error":"unauthorized"}' ;;
  */login) code=200; body='<html></html>' ;;
esac
[ -n "$out" ] && [ "$out" != /dev/null ] && printf '%s' "$body" >"$out"
if [ -n "$hdr" ]; then
  { echo "HTTP/1.1 200 OK"; echo "X-Content-Type-Options: nosniff"
    for _ in $(seq 1 "\${STUB_XFO_COUNT:-1}"); do echo "X-Frame-Options: DENY"; done; } >"$hdr"
fi
printf '%s' "$code"
`;

const SS_STUB = `#!/usr/bin/env bash
echo "State  Recv-Q Send-Q Local Address:Port Peer Address:Port"
echo "LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:*"
[ "\${STUB_NO_TLS_PORT:-0}" = 1 ] || echo "LISTEN 0 4096 0.0.0.0:8443 0.0.0.0:*"
`;

const DF_STUB = `#!/usr/bin/env bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "/dev/vda1 1000 \${STUB_DISK_USED:-40} 500 \${STUB_DISK_USED:-40}% /"
`;

const FREE_STUB = `#!/usr/bin/env bash
echo "              total        used        free      shared  buff/cache   available"
echo "Mem:          16000        4000        8000         100        4000       11000"
`;

const GOOD_PS = [
  "postgres|running|healthy|0",
  "web|running|healthy|0",
  "worker|running|healthy|0",
  "caddy|running||0",
  "migrate|exited||0",
].join("\n");

let tmp: string;
let bin: string;
let repo: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vtp-pdc-"));
  bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  for (const [n, c] of Object.entries({ docker: DOCKER_STUB, curl: CURL_STUB, ss: SS_STUB, df: DF_STUB, free: FREE_STUB })) {
    fs.writeFileSync(path.join(bin, n), c, { mode: 0o755 });
  }
  // Bản sao tối thiểu của repo để script `cd "$(dirname "$0")/.."` rơi vào thư mục có .env thử nghiệm.
  repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(repo, "scripts/post-deploy-check.sh"));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(env: Record<string, string> = {}, ps = GOOD_PS, dotenv: string | null = "APP_SECRET=abc\nAUTH_URL=http://10.0.0.5:8080\n") {
  fs.writeFileSync(path.join(tmp, "ps.txt"), `${ps}\n`);
  const envFile = path.join(repo, ".env");
  fs.rmSync(envFile, { force: true });
  if (dotenv !== null) fs.writeFileSync(envFile, dotenv, { mode: 0o600 });
  const r = spawnSync("bash", [path.join(repo, "scripts/post-deploy-check.sh")], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, STUB_DIR: tmp, ...env } as unknown as NodeJS.ProcessEnv,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

it("script pass bash -n", () => {
  const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
});

describe("post-deploy-check.sh với docker/curl giả", () => {
  it("tất cả đều đạt: mã thoát 0, không FAIL", () => {
    const r = run();
    expect(r.out).not.toMatch(/^FAIL/m);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/PASS\s+service migrate/);
    expect(r.out).toMatch(/PASS\s+schema pgboss/);
    expect(r.out).toContain("Tổng: 0 FAIL");
    expect(r.out).not.toContain("abc"); // không in giá trị .env
  });

  it("migrate thoát mã 1 -> FAIL, mã thoát 1", () => {
    const r = run({}, GOOD_PS.replace("migrate|exited||0", "migrate|exited||1"));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL\s+service migrate/);
  });

  it("worker không healthy -> FAIL", () => {
    const r = run({}, GOOD_PS.replace("worker|running|healthy|0", "worker|running|unhealthy|0"));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL\s+service worker/);
  });

  it("/api/health 502, /api/documents 200 và X-Frame-Options lặp -> FAIL", () => {
    const r = run({ STUB_HEALTH_CODE: "502", STUB_DOCS_CODE: "200", STUB_XFO_COUNT: "2" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL\s+GET \/api\/health/);
    expect(r.out).toMatch(/FAIL\s+GET \/api\/documents/);
    expect(r.out).toMatch(/FAIL\s+header x-frame-options/);
  });

  it("/data không ghi được, thiếu pgboss, Postgres công bố cổng, thiếu cổng 8443 -> FAIL", () => {
    const r = run({ STUB_WEB_WRITE: "1", STUB_PGBOSS: "", STUB_PGPORT: "0.0.0.0:5432", STUB_NO_TLS_PORT: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL\s+\/data ghi được \(web\)/);
    expect(r.out).toMatch(/FAIL\s+schema pgboss/);
    expect(r.out).toMatch(/FAIL\s+Postgres không công bố cổng/);
    expect(r.out).toMatch(/FAIL\s+cổng 8443/);
  });

  it("đĩa đầy 95% chỉ là WARN (mã thoát 0)", () => {
    const r = run({ STUB_DISK_USED: "95" });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/WARN\s+dung lượng đĩa/);
  });

  it(".env còn change-me -> FAIL; AUTH_URL localhost -> WARN", () => {
    const r = run({}, GOOD_PS, "APP_SECRET=change-me\nAUTH_URL=http://localhost:8080\n");
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL\s+\.env còn giá trị mẫu/);
    expect(r.out).toMatch(/WARN\s+AUTH_URL/);
  });

  it("từng bí mật còn change-me -> FAIL; ADMIN_PASSWORD mẫu chỉ WARN", () => {
    for (const k of ["POSTGRES_PASSWORD=change-me", "DATABASE_URL=postgres://vanthu:change-me@postgres:5432/vanthu", "AUTH_SECRET=change-me"]) {
      const r = run({}, GOOD_PS, `${k}\nAUTH_URL=http://10.0.0.5:8080\n`);
      expect(r.status, k).toBe(1);
      expect(r.out).toMatch(/FAIL\s+\.env còn giá trị mẫu/);
    }
    const w = run({}, GOOD_PS, "ADMIN_PASSWORD=change-me\nAUTH_URL=http://10.0.0.5:8080\n");
    expect(w.status, w.out).toBe(0);
    expect(w.out).toMatch(/WARN\s+ADMIN_PASSWORD.*Quản trị > Người dùng/);
  });

  it("có dify-gateway: kiểm tra mạng từ worker; lỗi chỉ là WARN", () => {
    const r = run({ STUB_GATEWAY: "1" }, `${GOOD_PS}\ndify-gateway|running||0`);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/PASS\s+service dify-gateway/);
    expect(r.out).toMatch(/WARN\s+worker -> dify-gateway/);
  });
});
