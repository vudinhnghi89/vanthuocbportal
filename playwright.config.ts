import { defineConfig } from "@playwright/test";
import { ensurePorts } from "./e2e/support/env";

const { appPort } = ensurePorts();
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "./e2e-results/artifacts",
  globalSetup: "./e2e/global-setup.ts",
  // One shared server/database/worker queue: scenarios run one after another, never in parallel.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: "e2e-results/report.json" }]],
  use: {
    baseURL: `http://127.0.0.1:${appPort}`,
    locale: "vi-VN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      // Sandbox/CI without a downloaded browser: PW_CHROMIUM_PATH=/path/to/chrome
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
      args: isRoot ? ["--no-sandbox"] : [],
    },
  },
});
