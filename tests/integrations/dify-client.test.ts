import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DifyConfigError,
  DifyHttpError,
  DifyOutputError,
  DifyTimeoutError,
  DifyWorkflowError,
  pickRule,
  runOcr,
  type DifySettings,
} from "@/integrations/dify/client";
import { echoBearer, startDifyMock, workflowOk, type DifyMock } from "../mocks/dify-server";

const API_KEY = "app-SECRETKEY1234";
let mock: DifyMock;
let pdfPath: string;
let tmpDir: string;
const pdfBytes = Buffer.from("%PDF-1.4 fake pdf bytes");

function cfg(over: Partial<DifySettings> = {}): DifySettings {
  return {
    baseUrl: mock.url,
    apiKey: API_KEY,
    inputVar: "doc",
    outputVarMd: "md",
    outputVarJson: "json",
    timeoutS: 5,
    retries: 2,
    ...over,
  };
}
const fast = { sleep: async () => {} };

beforeAll(async () => {
  mock = await startDifyMock();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dify-test-"));
  pdfPath = path.join(tmpDir, "van-ban.pdf");
  fs.writeFileSync(pdfPath, pdfBytes);
});
afterAll(async () => {
  await mock.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  mock.uploads.length = 0;
  mock.runs.length = 0;
  mock.onUpload = () => ({ body: { id: "file-1" } });
  mock.onRun = () => workflowOk({ md: "# Xin chao", json: { a: 1 } });
});

describe("runOcr", () => {
  it("uploads then runs the workflow and returns markdown + json", async () => {
    const out = await runOcr(cfg(), pdfPath, fast);
    expect(out).toEqual({ markdown: "# Xin chao", json: { a: 1 } });

    const up = mock.uploads[0];
    expect(up.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(up.form!.get("user")).toBe("van-thu-portal");
    const file = up.form!.get("file") as File;
    expect(file.name).toBe("van-ban.pdf");
    expect(file.type).toBe("application/pdf");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(pdfBytes);

    const run = mock.runs[0];
    expect(run.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(run.json).toEqual({
      inputs: { doc: { type: "document", transfer_method: "local_file", upload_file_id: "file-1" } },
      response_mode: "blocking",
      user: "van-thu-portal",
    });
  });

  it("normalises a trailing slash on baseUrl", async () => {
    const out = await runOcr(cfg({ baseUrl: mock.url + "/" }), pdfPath, fast);
    expect(out.markdown).toBe("# Xin chao");
  });

  it("retries 500 twice then succeeds", async () => {
    mock.onRun = (_r, n) => (n <= 2 ? { status: 500, body: { message: "boom" } } : workflowOk({ md: "ok", json: {} }));
    const out = await runOcr(cfg(), pdfPath, fast);
    expect(out.markdown).toBe("ok");
    expect(mock.runs).toHaveLength(3);
  });

  it("retries 429", async () => {
    mock.onUpload = (_r, n) => (n === 1 ? { status: 429, body: {} } : { body: { id: "f" } });
    await runOcr(cfg(), pdfPath, fast);
    expect(mock.uploads).toHaveLength(2);
  });

  it("gives up after retries and throws DifyHttpError (1 + retries attempts)", async () => {
    mock.onRun = () => ({ status: 503, body: { message: "down" } });
    const err = await runOcr(cfg({ retries: 2 }), pdfPath, fast).catch((e) => e);
    expect(err).toBeInstanceOf(DifyHttpError);
    expect(err.status).toBe(503);
    expect(mock.runs).toHaveLength(3);
  });

  it("does not retry 401 and never leaks the api key", async () => {
    mock.onUpload = () => ({ status: 401, body: { code: "unauthorized", message: "bad key" } });
    const err = await runOcr(cfg(), pdfPath, fast).catch((e) => e);
    expect(err).toBeInstanceOf(DifyHttpError);
    expect(err.status).toBe(401);
    expect(mock.uploads).toHaveLength(1);
    expect(String(err.message)).not.toContain(API_KEY);
    expect(JSON.stringify(err)).not.toContain(API_KEY);
  });

  it("truncates a huge error body", async () => {
    mock.onUpload = () => ({ status: 400, body: "x".repeat(5000) });
    const err = await runOcr(cfg(), pdfPath, fast).catch((e) => e);
    expect(err).toBeInstanceOf(DifyHttpError);
    expect(err.message.length).toBeLessThan(600);
  });

  it("throws DifyTimeoutError when the server is too slow (after retries)", async () => {
    mock.onUpload = () => ({ body: { id: "f" }, delayMs: 500 });
    const err = await runOcr(cfg({ timeoutS: 0.05, retries: 1 }), pdfPath, fast).catch((e) => e);
    expect(err).toBeInstanceOf(DifyTimeoutError);
    expect(mock.uploads).toHaveLength(2);
  });

  it("throws DifyWorkflowError when status is failed, including error text", async () => {
    mock.onRun = () => ({
      body: { data: { status: "failed", outputs: null, error: "node X exploded" } },
    });
    const err = await runOcr(cfg(), pdfPath, fast).catch((e) => e);
    expect(err).toBeInstanceOf(DifyWorkflowError);
    expect(err.message).toContain("node X exploded");
    expect(mock.runs).toHaveLength(1);
  });

  it("throws DifyOutputError naming the missing markdown variable", async () => {
    mock.onRun = () => workflowOk({ json: {} });
    const err = await runOcr(cfg(), pdfPath, fast).catch((e) => e);
    expect(err).toBeInstanceOf(DifyOutputError);
    expect(err.message).toContain("md");
  });

  it("throws DifyOutputError when the json variable is missing", async () => {
    mock.onRun = () => workflowOk({ md: "x" });
    const err = await runOcr(cfg(), pdfPath, fast).catch((e) => e);
    expect(err).toBeInstanceOf(DifyOutputError);
    expect(err.message).toContain("json");
  });

  it("throws DifyOutputError when json is an unparsable string", async () => {
    mock.onRun = () => workflowOk({ md: "x", json: "not json {" });
    await expect(runOcr(cfg(), pdfPath, fast)).rejects.toBeInstanceOf(DifyOutputError);
  });

  it("parses a JSON string and strips ```json fences", async () => {
    mock.onRun = () => workflowOk({ md: "x", json: '```json\n{"so_van_ban": "12/QD"}\n```' });
    const out = await runOcr(cfg(), pdfPath, fast);
    expect(out.json).toEqual({ so_van_ban: "12/QD" });
    mock.onRun = () => workflowOk({ md: "x", json: '{"k":1}' });
    expect((await runOcr(cfg(), pdfPath, fast)).json).toEqual({ k: 1 });
  });

  it("backs off exponentially (1s base, factor 2) between attempts", async () => {
    mock.onRun = (_r, n) => (n <= 2 ? { status: 500 } : workflowOk({ md: "ok", json: {} }));
    const delays: number[] = [];
    await runOcr(cfg(), pdfPath, { sleep: async (ms) => void delays.push(ms) });
    expect(delays).toEqual([1000, 2000]);
  });
});

function expectNoKey(err: unknown) {
  const text = `${(err as Error).message} ${JSON.stringify(err)}`;
  expect(text).not.toContain(API_KEY);
  for (let i = 0; i + 8 <= API_KEY.length; i++) {
    expect(text).not.toContain(API_KEY.slice(i, i + 8));
  }
}

describe("api key never leaks", () => {
  for (const status of [400, 401, 500]) {
    for (const cut of [10, 297, 300, 305]) {
      it(`HTTP ${status} body echoing the key (key at char ${cut})`, async () => {
        mock.onUpload = (r) => ({ status, body: echoBearer(r, cut) });
        const err = await runOcr(cfg({ retries: 0 }), pdfPath, fast).catch((e) => e);
        expect(err).toBeInstanceOf(DifyHttpError);
        expectNoKey(err);
      });
    }
  }

  it("scrubs url-encoded and json-escaped forms of the key", async () => {
    const key = 'app-a/b"c+d e';
    mock.onUpload = () => ({
      status: 400,
      body: `${encodeURIComponent(key)} | ${JSON.stringify(key).slice(1, -1)} | ${key}`,
    });
    const err = await runOcr(cfg({ apiKey: key, retries: 0 }), pdfPath, fast).catch((e) => e);
    expect(err.message).not.toContain(encodeURIComponent(key));
    expect(err.message).not.toContain(JSON.stringify(key).slice(1, -1));
    expect(err.message).not.toContain(key);
  });

  for (const cut of [10, 297, 300]) {
    it(`workflow data.error echoing the key (key at char ${cut})`, async () => {
      mock.onRun = (r) => ({ body: { data: { status: "failed", error: echoBearer(r, cut) } } });
      const err = await runOcr(cfg(), pdfPath, fast).catch((e) => e);
      expect(err).toBeInstanceOf(DifyWorkflowError);
      expectNoKey(err);
      const err2 = await pickRule(cfg(), "m", [{ id: 1, title: "t", summary: "s" }], fast).catch((e) => e);
      expect(err2).toBeInstanceOf(DifyWorkflowError);
      expectNoKey(err2);
    });
  }
});

describe("settings guard", () => {
  it.each([NaN, undefined, -3, Infinity])("retries=%s terminates without looping", async (retries) => {
    mock.onRun = () => ({ status: 500, body: {} });
    const err = await runOcr(cfg({ retries: retries as number }), pdfPath, fast).catch((e) => e);
    expect(err).toBeInstanceOf(DifyHttpError);
    expect(mock.runs.length).toBeLessThanOrEqual(11);
  }, 3000);

  it("fractional and huge retries are floored/capped", async () => {
    mock.onRun = () => ({ status: 500, body: {} });
    await runOcr(cfg({ retries: 1.9 }), pdfPath, fast).catch(() => {});
    expect(mock.runs).toHaveLength(2);
    mock.runs.length = 0;
    await runOcr(cfg({ retries: 1000 }), pdfPath, fast).catch(() => {});
    expect(mock.runs).toHaveLength(11);
  });

  it.each([NaN, 0, -1, undefined, Infinity])("timeoutS=%s throws DifyConfigError, no request", async (t) => {
    const err = await runOcr(cfg({ timeoutS: t as number }), pdfPath, fast).catch((e) => e);
    expect(err).toBeInstanceOf(DifyConfigError);
    const err2 = await pickRule(cfg({ timeoutS: t as number }), "m", [], fast).catch((e) => e);
    expect(err2).toBeInstanceOf(DifyConfigError);
    expect(mock.uploads).toHaveLength(0);
    expect(mock.runs).toHaveLength(0);
  });
});

describe("pickRule", () => {
  const candidates = [
    { id: 3, title: "A", summary: "sa" },
    { id: 7, title: "B", summary: "sb" },
  ];
  const pick = (out: unknown) => {
    mock.onRun = () => workflowOk({ json: out });
    return pickRule(cfg(), "# md", candidates, fast);
  };

  it("sends markdown and candidates as inputs (no upload)", async () => {
    await pick(7);
    expect(mock.uploads).toHaveLength(0);
    expect(mock.runs[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(mock.runs[0].json).toEqual({
      inputs: { doc: "# md", candidates: JSON.stringify(candidates) },
      response_mode: "blocking",
      user: "van-thu-portal",
    });
  });

  it("accepts number, numeric string, JSON text and object", async () => {
    expect(await pick(7)).toBe(7);
    expect(await pick(" 3 ")).toBe(3);
    expect(await pick('{"rule_id": 3}')).toBe(3);
    expect(await pick({ rule_id: 7 })).toBe(7);
    expect(await pick('```json\n{"rule_id": "7"}\n```')).toBe(7);
  });

  it("returns null for an id outside the candidates", async () => {
    expect(await pick(99)).toBeNull();
    expect(await pick({ rule_id: 99 })).toBeNull();
  });

  it("returns null for empty or garbage output, never throws", async () => {
    expect(await pick("")).toBeNull();
    expect(await pick(null)).toBeNull();
    expect(await pick("hello")).toBeNull();
    expect(await pick({ foo: 1 })).toBeNull();
    expect(await pick(1.5)).toBeNull();
    mock.onRun = () => workflowOk({});
    expect(await pickRule(cfg(), "m", candidates, fast)).toBeNull();
  });

  it("throws typed errors on transport failure, without leaking the key", async () => {
    mock.onRun = () => ({ status: 500, body: {} });
    const err = await pickRule(cfg({ retries: 1 }), "m", candidates, fast).catch((e) => e);
    expect(err).toBeInstanceOf(DifyHttpError);
    expect(String(err.message)).not.toContain(API_KEY);
    expect(mock.runs).toHaveLength(2);
  });

  it("throws DifyWorkflowError when the agent workflow fails", async () => {
    mock.onRun = () => ({ body: { data: { status: "failed", error: "agent down" } } });
    await expect(pickRule(cfg(), "m", candidates, fast)).rejects.toBeInstanceOf(DifyWorkflowError);
  });
});
