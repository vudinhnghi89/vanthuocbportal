import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { request } from "@playwright/test";
import {
  ADMIN_PASSWORD, ADMIN_USERNAME, APP_SECRET, AUTH_SECRET, DIFY_API_KEY, ROOT, USER_PASSWORD, USER_USERNAME,
  appUrl, ensurePorts, mockUrl, stateFile,
} from "./support/env";

type Child = { name: string; proc: ChildProcess };

function dbUrlFor(adminUrl: string, name: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, label: string) {
  const r = spawnSync(cmd, args, { cwd: ROOT, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 60_000, child?: Child) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child && child.proc.exitCode !== null) throw new Error(`${what}: process ${child.name} exited early`);
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** Kill a whole process group (children are detached = session/group leaders). */
function killGroup(pid: number | undefined, sig: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(-pid, sig);
  } catch {
    /* already gone */
  }
}

export default async function globalSetup() {
  const { appPort, mockPort } = ensurePorts();
  const adminDbUrl = process.env.E2E_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://vtp:vtp@localhost:5432/vtp_test";
  const dbName = `vtp_e2e_${process.pid}_${Date.now()}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vtp-e2e-"));
  const logDir = path.join(process.env.E2E_LOG_DIR ?? path.join(ROOT, "e2e-results"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const children: Child[] = [];
  let dbCreated = false;
  let tornDown = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- NODE_ENV is dropped so next build/start pick production
  const { NODE_ENV: _nodeEnv, ...baseEnv } = process.env;
  const env = {
    ...baseEnv,
    DATABASE_URL: dbUrlFor(adminDbUrl, dbName),
    APP_SECRET,
    AUTH_SECRET,
    AUTH_URL: appUrl(),
    AUTH_TRUST_HOST: "true",
    DATA_DIR: path.join(tmp, "data"),
    PORT: String(appPort),
    ADMIN_USERNAME,
    ADMIN_PASSWORD,
    E2E_USER_USERNAME: USER_USERNAME,
    E2E_USER_PASSWORD: USER_PASSWORD,
    E2E_MOCK_URL: mockUrl(),
    E2E_DIFY_API_KEY: DIFY_API_KEY,
  } as unknown as NodeJS.ProcessEnv;

  const killAll = (sig: NodeJS.Signals) => children.forEach((c) => killGroup(c.proc.pid, sig));
  const dropDbScript =
    "const {Client}=require('pg');const c=new Client({connectionString:process.argv[1]});c.on('error',()=>{});" +
    "c.connect().then(()=>c.query('DROP DATABASE IF EXISTS \"'+process.argv[2]+'\" WITH (FORCE)')).catch(()=>{}).finally(()=>c.end().catch(()=>{}))";
  // Last-resort synchronous cleanup (runner killed by a signal or crashed before globalTeardown could run).
  const syncCleanup = () => {
    if (tornDown) return;
    tornDown = true;
    killAll("SIGKILL");
    if (dbCreated) spawnSync(process.execPath, ["-e", dropDbScript, adminDbUrl, dbName], { cwd: ROOT, stdio: "ignore" });
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  const onSignal = (code: number) => () => {
    syncCleanup();
    process.exit(code);
  };
  const sigint = onSignal(130);
  const sigterm = onSignal(143);
  process.on("exit", syncCleanup);
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);

  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    killAll("SIGTERM");
    const exited = (c: Child) => new Promise<void>((resolve) => {
      if (c.proc.exitCode !== null || c.proc.signalCode !== null) return resolve();
      c.proc.once("exit", () => resolve());
    });
    await Promise.race([Promise.all(children.map(exited)), new Promise((r) => setTimeout(r, 8000))]);
    killAll("SIGKILL");
    if (dbCreated) {
      const admin = new Client({ connectionString: adminDbUrl });
      admin.on("error", () => {});
      try {
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } catch (e) {
        console.warn(`[e2e] could not drop ${dbName}: ${(e as Error).message}`);
      } finally {
        await admin.end().catch(() => {});
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    process.off("exit", syncCleanup);
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  };

  const start = (name: string, cmd: string, args: string[]): Child => {
    const out = fs.openSync(path.join(logDir, `${name}.log`), "w");
    const proc = spawn(cmd, args, { cwd: ROOT, env, detached: true, stdio: ["ignore", out, out] });
    const child = { name, proc };
    children.push(child);
    return child;
  };

  try {
    process.env.E2E_STATE_DIR = path.join(tmp, "state");
    fs.mkdirSync(process.env.E2E_STATE_DIR, { recursive: true });

    const admin = new Client({ connectionString: adminDbUrl });
    admin.on("error", () => {});
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    dbCreated = true;
    await admin.end();

    const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
    run(tsx, ["src/db/migrate.ts"], env, "migrate");
    run(tsx, ["src/db/seed.ts"], env, "seed");
    run(tsx, ["e2e/support/seed-data.ts"], env, "seed-data");

    const mock = start("mock-dify", tsx, ["e2e/support/mock-dify.ts", "--port", String(mockPort)]);
    await waitFor(async () => (await fetch(`${mockUrl()}/__control`)).ok, "mock Dify", 30_000, mock);

    if (process.env.E2E_SKIP_BUILD !== "1") {
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      run(npm, ["run", "build"], env, "build");
    } else if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID")) || !fs.existsSync(path.join(ROOT, "dist", "worker.js"))) {
      throw new Error("E2E_SKIP_BUILD=1 but .next or dist/worker.js is missing");
    }

    const app = start("next", process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(appPort), "-H", "127.0.0.1"]);
    await waitFor(async () => (await fetch(`${appUrl()}/api/health`)).ok, "next start", 60_000, app);
    const worker = start("worker", process.execPath, [path.join(ROOT, "dist", "worker.js")]);
    await waitFor(async () => /\[worker\] started/.test(fs.readFileSync(path.join(logDir, "worker.log"), "utf8")), "worker", 30_000, worker);

    // Log in once per role (the login endpoint is limited to 5 attempts/minute/IP) and keep the cookies.
    for (const [role, username, password] of [["admin", ADMIN_USERNAME, ADMIN_PASSWORD], ["vanthu", USER_USERNAME, USER_PASSWORD]] as const) {
      const ctx = await request.newContext({ baseURL: appUrl() });
      try {
        const csrf = (await (await ctx.get("/api/auth/csrf")).json()).csrfToken as string;
        const res = await ctx.post("/api/auth/callback/credentials", {
          form: { csrfToken: csrf, username, password, redirect: "false" },
        });
        if (!res.ok()) throw new Error(`login ${role} failed: HTTP ${res.status()}`);
        const session = await (await ctx.get("/api/auth/session")).json();
        if (session?.user?.username !== username) throw new Error(`login ${role}: no session`);
        await ctx.storageState({ path: stateFile(role) });
      } finally {
        await ctx.dispose();
      }
    }
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
