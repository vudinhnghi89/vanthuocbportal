import { execFileSync } from "node:child_process";
import path from "node:path";

export const ROOT = path.resolve(__dirname, "..", "..");

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "E2e-Admin-Pass-9137";
export const USER_USERNAME = "vanthu";
export const USER_PASSWORD = "E2e-User-Pass-4821";

export const APP_SECRET = "0123456789abcdef0123456789abcdef0123";
export const AUTH_SECRET = "e2e-dummy-auth-secret";
export const DIFY_API_KEY = "app-e2e-key-0123456789abcdef";

/** Free TCP port on loopback (synchronous so playwright.config.ts can use it at load time). */
export function freePort(): number {
  const code =
    "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})";
  return Number(execFileSync(process.execPath, ["-e", code], { encoding: "utf8" }).trim());
}

/**
 * Ports are chosen once by the runner process (config load) and inherited by workers via env,
 * so every process sees the same values.
 */
export function ensurePorts(): { appPort: number; mockPort: number } {
  process.env.E2E_APP_PORT ??= String(freePort());
  process.env.E2E_MOCK_PORT ??= String(freePort());
  return { appPort: Number(process.env.E2E_APP_PORT), mockPort: Number(process.env.E2E_MOCK_PORT) };
}

export const appUrl = () => `http://127.0.0.1:${process.env.E2E_APP_PORT}`;
export const mockUrl = () => `http://127.0.0.1:${process.env.E2E_MOCK_PORT}`;
export const stateFile = (role: "admin" | "vanthu") => path.join(process.env.E2E_STATE_DIR ?? "", `${role}.json`);

export const UNITS = {
  secretariat: "Ban thư ký",
  planning: "Phòng Kế hoạch",
  finance: "Phòng Tài chính",
  admin: "Phòng Hành chính",
} as const;
