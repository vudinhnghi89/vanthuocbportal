import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";
import { startDifyMock, workflowOk, type DifyMock } from "../mocks/dify-server";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({
  get db() {
    return holder.db;
  },
}));

import { disambiguate } from "@/matching/disambiguate";
import {
  DifyHttpError,
  DifyNetworkError,
  DifyOutputError,
  DifyTimeoutError,
  DifyWorkflowError,
} from "@/integrations/dify/client";
import { DifyNotConfiguredError, getDifySettings, saveDifySettings } from "@/server/settings";
import type { Rule } from "@/server/rules";

const FAKE_KEY = "app-FAKEKEY-9999";
const cfg = {
  baseUrl: "http://x/v1",
  apiKey: FAKE_KEY,
  inputVar: "text",
  outputVarMd: "md",
  outputVarJson: "json",
  timeoutS: 5,
  retries: 0,
};
const rule = (id: number, o: Partial<Rule> = {}): Rule =>
  ({
    id,
    issuer: `issuer-${id}`,
    docType: `type-${id}`,
    title: `Title ${id}`,
    summary: `Summary ${id}`,
    mainUnitId: 1,
    infoUnitId: null,
    priority: 0,
    active: true,
    ...o,
  }) as Rule;
const getSettings = async () => cfg;

describe("disambiguate", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns the candidate object picked by the agent", async () => {
    const cands = [rule(1), rule(2), rule(3)];
    const pick = vi.fn().mockResolvedValue(2);
    expect(await disambiguate("md", cands, { getSettings, pick })).toBe(cands[1]);
    expect(pick).toHaveBeenCalledWith(cfg, "md", expect.any(Array));
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns null for an id outside the candidates", async () => {
    const pick = vi.fn().mockResolvedValue(99);
    expect(await disambiguate("md", [rule(1), rule(2)], { getSettings, pick })).toBeNull();
  });

  it("returns null when the agent returns null", async () => {
    const pick = vi.fn().mockResolvedValue(null);
    expect(await disambiguate("md", [rule(1), rule(2)], { getSettings, pick })).toBeNull();
  });

  const MSG = "provider said SECRET-MESSAGE with doc text";
  const failures: [string, () => unknown, "settings" | "pick"][] = [
    ["DifyNotConfiguredError", () => new DifyNotConfiguredError("dify_agent"), "settings"],
    ["DifyHttpError", () => new DifyHttpError(500, MSG), "pick"],
    ["DifyTimeoutError", () => new DifyTimeoutError(5), "pick"],
    ["DifyNetworkError", () => new DifyNetworkError(MSG), "pick"],
    ["DifyWorkflowError", () => new DifyWorkflowError("failed", MSG), "pick"],
    ["DifyOutputError", () => new DifyOutputError(MSG), "pick"],
    ["Error", () => new Error(MSG), "pick"],
  ];
  it.each(failures)("%s -> null with one warning naming only the class", async (name, make, where) => {
    const err = make();
    const thrower = vi.fn().mockRejectedValue(err);
    const deps =
      where === "settings"
        ? { getSettings: thrower, pick: vi.fn() }
        : { getSettings, pick: thrower };
    const markdown = "DOCUMENT-CONTENT-XYZ";
    expect(await disambiguate(markdown, [rule(1), rule(2)], deps)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const text = warn.mock.calls[0].map(String).join(" ");
    expect(text).toContain(name);
    for (const bad of [MSG, "SECRET-MESSAGE", markdown, FAKE_KEY, "Title 1"]) expect(text).not.toContain(bad);
  });

  it("không bao giờ ném từ catch: constructor getter ném lỗi -> 'Error'", async () => {
    const err = new Error("x");
    Object.defineProperty(err, "constructor", {
      get() {
        throw new Error("boom");
      },
    });
    const pick = vi.fn().mockRejectedValue(err);
    expect(await disambiguate("md", [rule(1), rule(2)], { getSettings, pick })).toBeNull();
    expect(warn.mock.calls[0].map(String).join(" ")).toMatch(/failed: Error$/);
  });

  it("tên lớp chứa ký tự lạ hoặc quá dài -> 'Error'", async () => {
    for (const name of ["Bad\nName\u202e", "x".repeat(65), "", "Evil Name"]) {
      warn.mockClear();
      const C = class extends Error {};
      Object.defineProperty(C, "name", { value: name });
      const pick = vi.fn().mockRejectedValue(new C("secret"));
      expect(await disambiguate("md", [rule(1), rule(2)], { getSettings, pick })).toBeNull();
      expect(warn.mock.calls[0].map(String).join(" ")).toMatch(/failed: Error$/);
    }
  });

  it("non-Error throw -> null, one warning without the thrown text", async () => {
    const pick = vi.fn().mockRejectedValue("boom-string-secret");
    expect(await disambiguate("md", [rule(1), rule(2)], { getSettings, pick })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].map(String).join(" ")).not.toContain("boom-string-secret");
  });

  it("truncates markdown to 30000 chars", async () => {
    const pick = vi.fn().mockResolvedValue(null);
    await disambiguate("a".repeat(100_000), [rule(1), rule(2)], { getSettings, pick });
    expect(pick.mock.calls[0][1]).toHaveLength(30_000);
  });

  it("does not split a surrogate pair at the cut", async () => {
    const pick = vi.fn().mockResolvedValue(null);
    const md = "a".repeat(29_999) + "😀" + "tail";
    await disambiguate(md, [rule(1), rule(2)], { getSettings, pick });
    const sent: string = pick.mock.calls[0][1];
    expect(sent).toBe("a".repeat(29_999) + "😀");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(sent)).toBe(false);
  });

  it("sends only {id,title,summary} with null -> ''", async () => {
    const pick = vi.fn().mockResolvedValue(null);
    await disambiguate("md", [rule(1, { title: null as unknown as string, summary: null as unknown as string }), rule(2)], {
      getSettings,
      pick,
    });
    expect(pick.mock.calls[0][2]).toEqual([
      { id: 1, title: "", summary: "" },
      { id: 2, title: "Title 2", summary: "Summary 2" },
    ]);
  });

  it("0 candidates -> null without calling Dify", async () => {
    const pick = vi.fn();
    const gs = vi.fn();
    expect(await disambiguate("md", [], { getSettings: gs, pick })).toBeNull();
    expect(pick).not.toHaveBeenCalled();
    expect(gs).not.toHaveBeenCalled();
  });

  it("1 candidate -> returned without calling Dify", async () => {
    const pick = vi.fn();
    const gs = vi.fn();
    const c = rule(7);
    expect(await disambiguate("md", [c], { getSettings: gs, pick })).toBe(c);
    expect(pick).not.toHaveBeenCalled();
    expect(gs).not.toHaveBeenCalled();
  });
});

const mode = dbSuiteMode(process.env);
describe.skipIf(mode !== "run")("disambiguate with real pickRule + mock Dify", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let mock: DifyMock;
  let savedSecret: string | undefined;
  beforeAll(async () => {
    savedSecret = process.env.APP_SECRET;
    process.env.APP_SECRET = "k".repeat(48);
    t = await createTestDb();
    holder.db = t.db;
    mock = await startDifyMock();
    await t.db.insert(schema.users).values({ id: 1, username: "admin1", passwordHash: "x", role: "admin" });
    await saveDifySettings(
      "dify_agent",
      { baseUrl: mock.url, apiKey: FAKE_KEY, inputVar: "text", outputVarMd: "md", outputVarJson: "json", timeoutS: 5, retries: 0 },
      1,
      t.db,
    );
  });
  afterAll(async () => {
    await mock?.close();
    await t?.cleanup();
    if (savedSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = savedSecret;
  });

  it("agent returns rule_id -> that Rule; HTTP 500 -> null", async () => {
    const cands = [rule(10), rule(20)];
    const deps = { getSettings: (k: Parameters<typeof getDifySettings>[0]) => getDifySettings(k, t.db) };
    mock.onRun = () => workflowOk({ json: { rule_id: 20 } });
    expect(await disambiguate("md", cands, deps)).toBe(cands[1]);
    mock.onRun = () => ({ status: 500, body: "oops" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await disambiguate("md", cands, deps)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
