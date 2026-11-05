import { describe, expect, it } from "vitest";
import { checkDb } from "@/worker/healthcheck";

describe("worker healthcheck", () => {
  it("is false without a URL or when the database is unreachable", async () => {
    expect(await checkDb(undefined)).toBe(false);
    expect(await checkDb("postgres://u:p@127.0.0.1:1/none", 500)).toBe(false);
  });
  it.skipIf(!process.env.DATABASE_URL)("is true when select 1 succeeds", async () => {
    expect(await checkDb(process.env.DATABASE_URL)).toBe(true);
  });
});
