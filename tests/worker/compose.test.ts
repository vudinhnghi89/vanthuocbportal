import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SHUTDOWN_TIMEOUT_MS } from "@/worker/config";

const compose = readFileSync(path.resolve(__dirname, "../../docker-compose.yml"), "utf8");

/** Khối của một service ở cấp 2 space dưới `services:` (đến service kế tiếp). */
function serviceBlock(name: string): string {
  const m = compose.match(new RegExp(`^  ${name}:\\n((?:    .*\\n|\\s*\\n)*)`, "m"));
  if (!m) throw new Error(`service ${name} not found`);
  return m[1];
}

function graceSeconds(block: string): number | null {
  const m = block.match(/^ {4}stop_grace_period:\s*(\d+)(s|m)\s*$/m);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "m" ? 60 : 1);
}

describe("worker stop_grace_period", () => {
  it("is longer than the graceful shutdown timeout", () => {
    const grace = graceSeconds(serviceBlock("worker"));
    expect(grace).not.toBeNull();
    expect(grace! * 1000).toBeGreaterThan(SHUTDOWN_TIMEOUT_MS);
  });
  it("is set only on the worker", () => {
    for (const s of ["web", "postgres", "caddy"]) {
      expect(graceSeconds(serviceBlock(s))).toBeNull();
    }
  });
});
