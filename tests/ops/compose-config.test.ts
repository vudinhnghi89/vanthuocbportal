import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { SHUTDOWN_TIMEOUT_MS } from "@/worker/config";

const ROOT = path.resolve(__dirname, "../..");
const hasCompose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
if (!hasCompose) console.warn("[compose-config.test] BỎ QUA: không có `docker compose` CLI trên máy này");

type Svc = {
  ports?: { published?: string | number; target: number }[];
  depends_on?: Record<string, { condition: string }>;
  volumes?: { source?: string; target: string }[];
  networks?: Record<string, unknown> | string[];
  network_mode?: string;
  healthcheck?: { test?: unknown };
  mem_limit?: string | number;
  deploy?: { resources?: { limits?: { memory?: string } } };
  stop_grace_period?: string;
  command?: string[];
  restart?: string;
  environment?: Record<string, string>;
};

function config(files: string[]): Record<string, Svc> {
  const r = spawnSync("docker", ["compose", ...files.flatMap((f) => ["-f", f]), "config", "--format", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // Không đặt DATABASE_URL: compose phải tự ghép từ POSTGRES_PASSWORD.
      POSTGRES_PASSWORD: "s3cret-._~Pw",
      APP_SECRET: "x".repeat(40),
      AUTH_SECRET: "x",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "password-1",
    } as unknown as NodeJS.ProcessEnv,
  });
  if (r.status !== 0) throw new Error(`docker compose config thất bại: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { services: Record<string, Svc> }).services;
}

describe.skipIf(!hasCompose)("docker-compose.yml (docker compose config)", () => {
  const svc = config(["docker-compose.yml"]);

  it("chỉ caddy công bố cổng ra máy chủ: 8080 và 8443", () => {
    for (const [name, s] of Object.entries(svc)) {
      if (name !== "caddy") expect(s.ports ?? [], `${name} không được công bố cổng`).toEqual([]);
    }
    const published = (svc.caddy.ports ?? []).map((p) => String(p.published)).sort();
    expect(published).toEqual(["8080", "8443"]);
  });

  it("web và worker chờ migrate hoàn tất thành công, migrate là one-shot", () => {
    for (const n of ["web", "worker"]) {
      expect(svc[n].depends_on?.migrate?.condition).toBe("service_completed_successfully");
      expect(svc[n].depends_on?.postgres?.condition).toBe("service_healthy");
    }
    expect(svc.migrate.restart).toBe("no");
    expect(svc.migrate.command).toEqual(["node", "dist/migrate.js"]);
    expect(svc.migrate.depends_on?.postgres?.condition).toBe("service_healthy");
  });

  it("worker.stop_grace_period lớn hơn SHUTDOWN_TIMEOUT_MS", () => {
    const m = /^(\d+)(ms|s|m)$/.exec(String(svc.worker.stop_grace_period));
    expect(m).not.toBeNull();
    const sec = m![2] === "m" ? Number(m![1]) * 60 : m![2] === "s" ? Number(m![1]) : Number(m![1]) / 1000;
    expect(sec * 1000).toBeGreaterThan(SHUTDOWN_TIMEOUT_MS);
  });

  it("appdata gắn vào web và worker, không gắn vào caddy", () => {
    const has = (n: string) => (svc[n].volumes ?? []).some((v) => v.source === "appdata" && v.target === "/data");
    expect(has("web")).toBe(true);
    expect(has("worker")).toBe(true);
    expect(has("caddy")).toBe(false);
  });

  it("không service nào dùng network_mode host", () => {
    for (const [n, s] of Object.entries(svc)) expect(s.network_mode, n).not.toBe("host");
  });

  it("web, worker, postgres có healthcheck", () => {
    for (const n of ["web", "worker", "postgres"]) expect(svc[n].healthcheck?.test, n).toBeTruthy();
  });

  it("mọi service có giới hạn bộ nhớ", () => {
    for (const [n, s] of Object.entries(svc)) {
      expect(s.mem_limit ?? s.deploy?.resources?.limits?.memory, `${n} thiếu mem_limit`).toBeTruthy();
    }
  });

  it("web, worker, migrate đều nhận DATABASE_URL (environment) ghép từ POSTGRES_PASSWORD", () => {
    for (const n of ["web", "worker", "migrate"]) {
      expect(svc[n].environment?.DATABASE_URL, n).toBe("postgres://vanthu:s3cret-._~Pw@postgres:5432/vanthu");
    }
    expect(Object.keys(svc.postgres.environment ?? {})).not.toContain("DATABASE_URL");
  });

  it("thiếu POSTGRES_PASSWORD -> compose config thất bại", () => {
    const r = spawnSync("docker", ["compose", "config", "--format", "json"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, APP_SECRET: "x".repeat(40), AUTH_SECRET: "x", ADMIN_USERNAME: "a", ADMIN_PASSWORD: "password-1" } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("POSTGRES_PASSWORD");
  });

  it("mỗi service chỉ nhận biến cần thiết (không lộ ADMIN_PASSWORD/POSTGRES_PASSWORD cho web/worker)", () => {
    for (const n of ["web", "worker"]) {
      const keys = Object.keys(svc[n].environment ?? {});
      expect(keys).not.toContain("ADMIN_PASSWORD");
      expect(keys).not.toContain("POSTGRES_PASSWORD");
    }
    expect(Object.keys(svc.worker.environment ?? {})).not.toContain("AUTH_SECRET");
    expect(Object.keys(svc.migrate.environment ?? {}).sort()).toEqual(["ADMIN_PASSWORD", "ADMIN_USERNAME", "DATABASE_URL"]);
  });
});

describe.skipIf(!hasCompose)("docker-compose.dify.yml (override tùy chọn)", () => {
  it("cổng dify-gateway nằm trên cả internal và mạng dify; web/worker không vào mạng Dify", () => {
    const svc = config(["docker-compose.yml", "docker-compose.dify.yml"]);
    const nets = (n: string) => Object.keys((svc[n].networks ?? {}) as Record<string, unknown>).sort();
    expect(nets("dify-gateway")).toEqual(["dify", "internal"]);
    expect(nets("web")).toEqual(["internal"]);
    expect(nets("worker")).toEqual(["internal"]);
    expect(svc["dify-gateway"].ports ?? []).toEqual([]);
  });
});

it("Dockerfile đưa drizzle/ và dist/ vào image runtime", async () => {
  const fs = await import("node:fs");
  const df = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const runtime = df.slice(df.indexOf("AS runtime"));
  expect(runtime).toMatch(/COPY --from=build \/app\/drizzle \.\/drizzle/);
  expect(runtime).toMatch(/COPY --from=build \/app\/dist \.\/dist/);
});
