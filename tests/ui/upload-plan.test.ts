import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_REQUEST,
  MAX_REQUEST_BYTES,
  describeServerResult,
  planBatches,
  validateFile,
} from "@/lib/upload-plan";

const MB = 1024 * 1024;

describe("validateFile", () => {
  it("constants", () => {
    expect(MAX_FILE_BYTES).toBe(50 * MB);
    expect(MAX_FILES_PER_REQUEST).toBe(10);
    expect(MAX_REQUEST_BYTES).toBe(150 * MB);
  });
  it.each([
    ["valid pdf", { name: "a.pdf", size: 10, type: "application/pdf" }],
    ["upper case ext", { name: "A.PDF", size: 10, type: "application/pdf" }],
    ["no mime", { name: "a.pdf", size: 10 }],
    ["empty mime", { name: "a.pdf", size: 10, type: "" }],
    ["octet-stream", { name: "a.pdf", size: 10, type: "application/octet-stream" }],
    ["exactly 50 MiB", { name: "a.pdf", size: 50 * MB, type: "application/pdf" }],
  ])("accepts %s", (_n, f) => {
    expect(validateFile(f)).toEqual({ ok: true });
  });
  it.each([
    ["txt", { name: "a.txt", size: 10, type: "text/plain" }, "not_pdf"],
    ["no extension", { name: "pdf", size: 10, type: "application/pdf" }, "not_pdf"],
    ["pdf.exe", { name: "a.pdf.exe", size: 10 }, "not_pdf"],
    ["weird mime", { name: "a.pdf", size: 10, type: "image/png" }, "not_pdf"],
    ["empty", { name: "a.pdf", size: 0, type: "application/pdf" }, "empty"],
    ["50 MiB + 1", { name: "a.pdf", size: 50 * MB + 1, type: "application/pdf" }, "too_large"],
  ])("rejects %s", (_n, f, reason) => {
    const r = validateFile(f);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(reason);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

describe("planBatches", () => {
  const mk = (n: number, size = 1) => Array.from({ length: n }, (_, i) => ({ size, i }));
  it("empty", () => expect(planBatches([])).toEqual([]));
  it("caps at 10 files", () => {
    const b = planBatches(mk(12));
    expect(b.map((x) => x.length)).toEqual([10, 2]);
  });
  it("preserves order", () => {
    const files = mk(25);
    expect(planBatches(files).flat()).toEqual(files);
  });
  it("splits 49 MiB x 4 into 3 + 1", () => {
    expect(planBatches(mk(4, 49 * MB)).map((x) => x.length)).toEqual([3, 1]);
  });
  it("one big + many small", () => {
    const files = [{ size: 50 * MB }, { size: 50 * MB }, { size: 50 * MB }, { size: 1 }, { size: 1 }];
    const b = planBatches(files);
    expect(b.map((x) => x.length)).toEqual([3, 2]);
    for (const batch of b) expect(batch.reduce((s, f) => s + f.size, 0)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
  });
  it("exactly at cap stays together", () => {
    expect(planBatches([{ size: 50 * MB }, { size: 100 * MB }])).toHaveLength(1);
  });
});

describe("describeServerResult", () => {
  const names = [{ name: "a.pdf" }, { name: "b.pdf" }, { name: "c.pdf" }];
  it("201 mixed", () => {
    const out = describeServerResult(names, {
      kind: "http",
      status: 201,
      body: {
        results: [
          { filename: "a.pdf", ok: true, id: "1", status: "queued" },
          { filename: "b.pdf", ok: false, error: "Tệp rỗng", code: "empty" },
          { filename: "c.pdf", ok: true, id: "2", status: "queued" },
        ],
      },
    });
    expect(out).toEqual([{ ok: true }, { ok: false, message: "Tệp rỗng" }, { ok: true }]);
  });
  it("400 all failed", () => {
    const out = describeServerResult(names.slice(0, 2), {
      kind: "http",
      status: 400,
      body: {
        results: [
          { filename: "a.pdf", ok: false, error: "x1", code: "not_pdf" },
          { filename: "b.pdf", ok: false, error: "x2", code: "not_pdf" },
        ],
      },
    });
    expect(out).toEqual([
      { ok: false, message: "x1" },
      { ok: false, message: "x2" },
    ]);
  });
  it("missing result entries become errors", () => {
    const out = describeServerResult(names, { kind: "http", status: 201, body: { results: [] } });
    expect(out.every((o) => !o.ok)).toBe(true);
    expect(out).toHaveLength(3);
  });
  it.each([
    [413, /vượt quá/],
    [411, /kích thước/],
    [401, /đăng nhập lại/],
    [500, /máy chủ/i],
    [400, /không hợp lệ/i],
  ])("http %i without results", (status, re) => {
    const out = describeServerResult(names, { kind: "http", status, body: null });
    expect(out).toHaveLength(3);
    for (const o of out) {
      expect(o.ok).toBe(false);
      if (!o.ok) expect(o.message).toMatch(re);
    }
  });
  it("network error", () => {
    const out = describeServerResult(names, { kind: "network" });
    expect(out).toHaveLength(3);
    for (const o of out) if (!o.ok) expect(o.message).toMatch(/mạng/i);
  });
});
