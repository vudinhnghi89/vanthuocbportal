import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";
import { DEAD_QUEUE_OPTIONS, OCR_DEAD_QUEUE, OCR_QUEUE, getBoss, stopBoss } from "@/worker/queue";

const mode = dbSuiteMode(process.env);

describe.skipIf(mode !== "run")("queue settings are applied to pre-existing queues", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    t = await createTestDb();
    // Hàng đợi "cũ": đã tồn tại từ bản trước, không có deadLetter/heartbeat, dead queue retryLimit 2.
    const legacy = new PgBoss({ connectionString: t.url, supervise: false, schedule: false });
    legacy.on("error", () => {});
    await legacy.start();
    await legacy.createQueue(OCR_DEAD_QUEUE, { retryLimit: 2, retryDelay: 5, retryBackoff: true });
    await legacy.createQueue(OCR_QUEUE, { policy: "exclusive", retryLimit: 1, expireInSeconds: 600 });
    const before = await legacy.getQueue(OCR_QUEUE);
    expect(before?.deadLetter ?? null).toBeNull();
    await legacy.stop({ graceful: true, timeout: 2000 });
  }, 30_000);
  afterAll(async () => {
    try {
      await stopBoss(2000);
    } finally {
      await t?.cleanup();
    }
  }, 30_000);

  it("getBoss nâng cấp deadLetter, heartbeat, retry, expire của hàng đợi có sẵn", async () => {
    const boss = await getBoss({ connectionString: t.url });
    const q = await boss.getQueue(OCR_QUEUE);
    expect(q).toMatchObject({
      policy: "exclusive",
      deadLetter: OCR_DEAD_QUEUE,
      heartbeatSeconds: 120,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 3600,
    });
    const dead = await boss.getQueue(OCR_DEAD_QUEUE);
    expect(dead).toMatchObject({
      retryLimit: DEAD_QUEUE_OPTIONS.retryLimit,
      retryDelay: DEAD_QUEUE_OPTIONS.retryDelay,
      retryBackoff: true,
    });
    expect(DEAD_QUEUE_OPTIONS.retryLimit).toBe(10);
  });
});
