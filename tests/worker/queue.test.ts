import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";
import {
  OCR_DEAD_QUEUE,
  OCR_QUEUE,
  enqueueOcr,
  getBoss,
  startOcrWorker,
  stopBoss,
  type QueueOptions,
} from "@/worker/queue";

const mode = dbSuiteMode(process.env);

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15_000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(mode !== "run")("ocr queue", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let opts: QueueOptions;
  let stopWorker: (() => Promise<void>) | undefined;

  const newDoc = async (name: string) => {
    const [d] = await t.db
      .insert(schema.documents)
      .values({ filename: name, pdfPath: `/data/pdf/${name}.pdf` })
      .returning();
    return d.id;
  };

  beforeAll(async () => {
    t = await createTestDb();
    opts = {
      connectionString: t.url,
      retryDelay: 1,
      retryBackoff: false,
      pollingIntervalSeconds: 0.5,
      superviseIntervalSeconds: 1,
      monitorIntervalSeconds: 1,
      supervise: true,
    };
    await getBoss(opts);
  }, 30_000);

  afterAll(async () => {
    try {
      await stopWorker?.();
    } finally {
      try {
        await stopBoss();
      } finally {
        await t?.cleanup();
      }
    }
  }, 30_000);

  it("processes 3 documents strictly one at a time, in enqueue order", async () => {
    const ids = [await newDoc("a"), await newDoc("b"), await newDoc("c")];
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: string[] = [];
    const spans: Array<[number, number]> = [];
    const done = new Set<string>();
    for (const id of ids) expect(await enqueueOcr(id, opts)).toBeTruthy();
    const w = await startOcrWorker(async (id) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const s = Date.now();
      starts.push(id);
      await sleep(150);
      spans.push([s, Date.now()]);
      inFlight--;
      done.add(id);
    }, opts);
    stopWorker = () => w.stop();
    await waitFor(() => done.size === 3);
    expect(maxInFlight).toBe(1);
    expect(starts).toEqual(ids);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
    await w.stop();
    stopWorker = undefined;
    await getBoss(opts);
  }, 20_000);

  it("double enqueue of the same documentId creates exactly one job", async () => {
    const id = await newDoc("dup");
    const first = await enqueueOcr(id, opts);
    const second = await enqueueOcr(id, opts);
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    const seen: string[] = [];
    const w = await startOcrWorker(async (d) => {
      seen.push(d);
    }, opts);
    stopWorker = () => w.stop();
    await waitFor(() => seen.length >= 1);
    await sleep(1500);
    expect(seen).toEqual([id]);
    // sau khi xong, có thể enqueue lại (chạy lại văn bản lỗi)
    expect(await enqueueOcr(id, opts)).toBeTruthy();
    await waitFor(() => seen.length === 2);
    await w.stop();
    stopWorker = undefined;
    await getBoss(opts);
  }, 20_000);

  it("retries a job whose handler throws, then succeeds", async () => {
    const id = await newDoc("flaky");
    let calls = 0;
    const w = await startOcrWorker(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    }, opts);
    stopWorker = () => w.stop();
    await enqueueOcr(id, opts);
    await waitFor(() => calls === 2);
    await sleep(500);
    expect(calls).toBe(2);
    const jobs = await (await getBoss(opts)).findJobs(OCR_QUEUE, { key: id });
    expect(jobs.map((j) => j.state)).toEqual(["completed"]);
    await w.stop();
    stopWorker = undefined;
    await getBoss(opts);
  }, 20_000);

  it("redelivers a job whose worker process was killed mid-job, without duplicating the document", async () => {
    const id = await newDoc("crash");
    const before = (await t.db.execute(sql`select count(*)::int as n from documents`)).rows[0].n;
    const crashOpts: QueueOptions = { ...opts, expireInSeconds: 2 };
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.resolve(__dirname, "crash-worker.ts")],
      {
        env: { ...process.env, QUEUE_TEST_OPTIONS: JSON.stringify(crashOpts) },
        stdio: ["ignore", "pipe", "inherit"],
        cwd: path.resolve(__dirname, "../.."),
      },
    );
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    try {
      await waitFor(() => out.includes("ready"));
      await enqueueOcr(id, crashOpts);
      await waitFor(() => out.includes(`started:${id}`));
    } finally {
      child.kill("SIGKILL");
    }
    await new Promise((r) => child.once("exit", r));

    const processed: string[] = [];
    const w = await startOcrWorker(async (d) => {
      processed.push(d);
    }, crashOpts);
    stopWorker = () => w.stop();
    await waitFor(() => processed.length === 1);
    await sleep(500);
    expect(processed).toEqual([id]);
    const after = (await t.db.execute(sql`select count(*)::int as n from documents`)).rows[0].n;
    expect(after).toBe(before);
    const jobs = await (await getBoss(opts)).findJobs(OCR_QUEUE, { key: id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe("completed");
    await w.stop();
    stopWorker = undefined;
  }, 30_000);
  it("passes retryCount/retryLimit; a handler that marks failed on the last attempt is run exactly 3 times, failing once", async () => {
    const id = await newDoc("always-throws");
    const metas: Array<{ retryCount: number; retryLimit: number }> = [];
    let failedMarks = 0;
    const w = await startOcrWorker(async (_id, meta) => {
      metas.push(meta);
      if (meta.retryCount >= meta.retryLimit) {
        failedMarks++; // như handleOcrJob: đánh dấu failed rồi trả về, KHÔNG throw
        return;
      }
      throw new Error("transient");
    }, opts);
    stopWorker = () => w.stop();
    await enqueueOcr(id, { ...opts, retryLimit: 2 });
    await waitFor(() => failedMarks === 1);
    await sleep(1500);
    expect(metas).toEqual([
      { retryCount: 0, retryLimit: 2 },
      { retryCount: 1, retryLimit: 2 },
      { retryCount: 2, retryLimit: 2 },
    ]);
    expect(failedMarks).toBe(1);
    const jobs = await (await getBoss(opts)).findJobs(OCR_QUEUE, { key: id });
    expect(jobs.map((j) => j.state)).toEqual(["completed"]);
    await w.stop();
    stopWorker = undefined;
    await getBoss(opts);
  }, 20_000);

  it("a job that expires with no retries left reaches the dead-letter worker", async () => {
    const id = await newDoc("expires");
    const dead: string[] = [];
    let release: () => void = () => {};
    const hang = new Promise<void>((r) => (release = r));
    const w = await startOcrWorker(
      async () => {
        await hang;
      },
      { ...opts, deadHandler: async (d) => void dead.push(d) },
    );
    stopWorker = () => w.stop();
    await enqueueOcr(id, { ...opts, retryLimit: 0, expireInSeconds: 2 });
    try {
      await waitFor(() => dead.length === 1, 15_000);
    } finally {
      release();
    }
    expect(dead).toEqual([id]);
    const boss = await getBoss(opts);
    expect((await boss.findJobs(OCR_DEAD_QUEUE, { key: id })).length).toBeGreaterThanOrEqual(1);
    await w.stop();
    stopWorker = undefined;
  }, 25_000);
});
