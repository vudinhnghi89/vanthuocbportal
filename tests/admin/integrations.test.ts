import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";
import { startDifyMock, type DifyMock } from "../mocks/dify-server";

const authMock = vi.fn();
vi.mock("@/auth/config", () => ({ auth: () => authMock() }));
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({
  get db() {
    return holder.db;
  },
}));

import {
  DifyNotConfiguredError,
  SettingsError,
  getDifySettings,
  getDifySettingsView,
  saveDifySettings,
  testConnection,
  type DifySettingsInput,
} from "@/server/settings";
import { GET } from "@/app/api/admin/integrations/route";
import { PUT } from "@/app/api/admin/integrations/[key]/route";
import { POST } from "@/app/api/admin/integrations/[key]/test/route";

const mode = dbSuiteMode(process.env);
it.runIf(mode === "fail")("DATABASE_URL bắt buộc trong CI", () => {
  throw new Error("DATABASE_URL chưa đặt trong CI: test DB không thể chạy");
});

const session = (role: "admin" | "user") => ({
  user: { id: 1, username: "admin1", role, active: true },
  expires: "2099-01-01",
});
const KEY = "app-SECRETKEY-1234567890wxyz";
const jsonReq = (body: unknown, method = "PUT") =>
  new Request("http://x/api", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (key: string) => ({ params: Promise.resolve({ key }) });

describe.skipIf(mode !== "run")("integration settings", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let mock: DifyMock;
  let savedSecret: string | undefined;
  const input = (o: Partial<DifySettingsInput> = {}): DifySettingsInput => ({
    baseUrl: "https://dify.example.com/v1/",
    apiKey: KEY,
    inputVar: "file",
    outputVarMd: "markdown",
    outputVarJson: "json",
    timeoutS: 300,
    retries: 3,
    ...o,
  });
  const audits = () => t.db.select().from(schema.settingsAudit);
  const rawRow = async (key: "dify_ocr" | "dify_agent" = "dify_ocr") =>
    (await t.db.select().from(schema.integrationSettings).where(eq(schema.integrationSettings.key, key)))[0];

  beforeAll(async () => {
    savedSecret = process.env.APP_SECRET;
    process.env.APP_SECRET = "k".repeat(48);
    t = await createTestDb();
    holder.db = t.db;
    mock = await startDifyMock();
  });
  afterAll(async () => {
    await mock?.close();
    await t?.cleanup();
    if (savedSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = savedSecret;
  });
  beforeEach(async () => {
    authMock.mockReset();
    await t.db.delete(schema.settingsAudit);
    await t.db.delete(schema.integrationSettings);
    await t.db.delete(schema.users);
    await t.db.insert(schema.users).values({ id: 1, username: "admin1", passwordHash: "x", role: "admin" });
    mock.params.length = 0;
    mock.onParameters = () => ({ body: {} });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("saveDifySettings", () => {
    it("lưu lần đầu, chuẩn hóa URL, mã hóa key, getDifySettings giải mã", async () => {
      await saveDifySettings("dify_ocr", input({ inputVar: " file " }), 1, t.db);
      const row = await rawRow();
      expect(row.baseUrl).toBe("https://dify.example.com/v1");
      expect(row.inputVar).toBe("file");
      expect(row.apiKeyEnc).toMatch(/^v1:/);
      expect(row.apiKeyEnc).not.toContain(KEY);
      expect(row.updatedBy).toBe(1);
      const s = await getDifySettings("dify_ocr", t.db);
      expect(s).toEqual({
        baseUrl: "https://dify.example.com/v1",
        apiKey: KEY,
        inputVar: "file",
        outputVarMd: "markdown",
        outputVarJson: "json",
        timeoutS: 300,
        retries: 3,
      });
    });

    it.each([
      ["baseUrl rỗng", { baseUrl: "" }, "invalid_base_url"],
      ["baseUrl không phải URL", { baseUrl: "not a url" }, "invalid_base_url"],
      ["baseUrl ftp", { baseUrl: "ftp://x.com" }, "invalid_base_url"],
      ["baseUrl javascript", { baseUrl: "javascript:alert(1)" }, "invalid_base_url"],
      ["inputVar rỗng", { inputVar: "  " }, "invalid_var"],
      ["outputVarMd rỗng", { outputVarMd: "" }, "invalid_var"],
      ["outputVarJson dài 101", { outputVarJson: "a".repeat(101) }, "invalid_var"],
      ["timeoutS 0", { timeoutS: 0 }, "invalid_timeout"],
      ["timeoutS 601", { timeoutS: 601 }, "invalid_timeout"],
      ["timeoutS 1.5", { timeoutS: 1.5 }, "invalid_timeout"],
      ["timeoutS chuỗi", { timeoutS: "5" as never }, "invalid_timeout"],
      ["retries -1", { retries: -1 }, "invalid_retries"],
      ["retries 11", { retries: 11 }, "invalid_retries"],
      ["retries NaN", { retries: NaN }, "invalid_retries"],
    ])("từ chối: %s", async (_n, patch, code) => {
      await expect(saveDifySettings("dify_ocr", input(patch as never), 1, t.db)).rejects.toMatchObject({ code });
      await expect(saveDifySettings("dify_ocr", input(patch as never), 1, t.db)).rejects.toBeInstanceOf(SettingsError);
      expect(await rawRow()).toBeUndefined();
      expect(await audits()).toHaveLength(0);
    });

    it("chấp nhận biên timeout 1/600 và retries 0/10", async () => {
      await saveDifySettings("dify_ocr", input({ timeoutS: 1, retries: 0 }), 1, t.db);
      await saveDifySettings("dify_ocr", input({ timeoutS: 600, retries: 10, apiKey: "" }), 1, t.db);
      expect(await rawRow()).toMatchObject({ timeoutS: 600, retries: 10 });
    });

    it("key bắt buộc lần đầu (thiếu/rỗng)", async () => {
      await expect(saveDifySettings("dify_ocr", input({ apiKey: undefined }), 1, t.db)).rejects.toMatchObject({
        code: "api_key_required",
      });
      await expect(saveDifySettings("dify_ocr", input({ apiKey: "   " }), 1, t.db)).rejects.toMatchObject({
        code: "api_key_required",
      });
      expect(await rawRow()).toBeUndefined();
    });

    it("cập nhật với key trống/undefined giữ key cũ; key mới thay thế", async () => {
      await saveDifySettings("dify_ocr", input(), 1, t.db);
      const enc = (await rawRow()).apiKeyEnc;
      await saveDifySettings("dify_ocr", input({ apiKey: undefined, timeoutS: 200 }), 1, t.db);
      await saveDifySettings("dify_ocr", input({ apiKey: "", timeoutS: 100 }), 1, t.db);
      expect((await rawRow()).apiKeyEnc).toBe(enc);
      expect((await getDifySettings("dify_ocr", t.db)).apiKey).toBe(KEY);
      await saveDifySettings("dify_ocr", input({ apiKey: "app-NEWKEY-9999", timeoutS: 100 }), 1, t.db);
      expect((await getDifySettings("dify_ocr", t.db)).apiKey).toBe("app-NEWKEY-9999");
    });

    it("ghi đúng MỘT audit đã che, không chứa key/ciphertext", async () => {
      await saveDifySettings("dify_ocr", input(), 1, t.db);
      let rows = await audits();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ key: "dify_ocr", actorId: 1, beforeMasked: null });
      expect(rows[0].afterMasked).toMatchObject({
        baseUrl: "https://dify.example.com/v1",
        apiKeyMasked: "app-****wxyz",
        apiKeyChanged: true,
        timeoutS: 300,
      });
      await saveDifySettings("dify_ocr", input({ apiKey: "app-NEWKEY-9999", retries: 5 }), 1, t.db);
      rows = await audits();
      expect(rows).toHaveLength(2);
      const enc = (await rawRow()).apiKeyEnc!;
      const dump = JSON.stringify(rows);
      for (const secret of [KEY, "app-NEWKEY-9999", enc, "SECRETKEY", "NEWKEY"]) expect(dump).not.toContain(secret);
      const second = rows.find((r) => r.beforeMasked)!;
      expect(second.beforeMasked).toMatchObject({ apiKeyMasked: "app-****wxyz", retries: 3 });
      expect(second.afterMasked).toMatchObject({ apiKeyMasked: "app-****9999", apiKeyChanged: true, retries: 5 });
    });

    it("chỉ đổi cấu hình (không đổi key) ghi apiKeyChanged=false", async () => {
      await saveDifySettings("dify_ocr", input(), 1, t.db);
      await saveDifySettings("dify_ocr", input({ apiKey: "", timeoutS: 50 }), 1, t.db);
      const rows = await audits();
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.beforeMasked)!.afterMasked).toMatchObject({ apiKeyChanged: false, timeoutS: 50 });
    });

    it("audit không chứa ciphertext/key/trường thô của hàng DB sau nhiều lần lưu", async () => {
      await saveDifySettings("dify_ocr", input(), 1, t.db);
      const enc1 = (await rawRow()).apiKeyEnc!;
      await saveDifySettings("dify_ocr", input({ apiKey: "app-NEWKEY-9999" }), 1, t.db);
      const enc2 = (await rawRow()).apiKeyEnc!;
      await saveDifySettings("dify_ocr", input({ apiKey: "", retries: 1 }), 1, t.db);
      const rows = await audits();
      expect(rows).toHaveLength(3);
      const dump = JSON.stringify(rows);
      for (const s of [enc1, enc2, KEY, "app-NEWKEY-9999", "SECRETKEY", "NEWKEY", "apiKeyEnc", "api_key_enc", "updatedBy"]) {
        expect(dump).not.toContain(s);
      }
      const allowed = ["apiKeyMasked", "baseUrl", "inputVar", "outputVarJson", "outputVarMd", "retries", "timeoutS"];
      for (const r of rows) {
        expect(Object.keys(r.beforeMasked ?? {}).sort()).toEqual(r.beforeMasked ? allowed : []);
        expect(Object.keys(r.afterMasked as object).sort()).toEqual([...allowed, "apiKeyChanged"].sort());
      }
    });

    it("lưu lại y hệt (kể cả cùng key) không ghi và không thêm audit", async () => {
      await saveDifySettings("dify_ocr", input(), 1, t.db);
      const before = await rawRow();
      await saveDifySettings("dify_ocr", input(), 1, t.db);
      await saveDifySettings("dify_ocr", input({ apiKey: "" }), 1, t.db);
      expect(await audits()).toHaveLength(1);
      expect(await rawRow()).toEqual(before);
    });

    it("audit lỗi -> rollback toàn bộ", async () => {
      await saveDifySettings("dify_ocr", input(), 1, t.db);
      const before = await rawRow();
      await t.db.execute(`create or replace function fail_audit() returns trigger as $$ begin raise exception 'audit boom'; end $$ language plpgsql`);
      await t.db.execute(`create trigger fail_audit before insert on settings_audit for each row execute function fail_audit()`);
      try {
        await expect(saveDifySettings("dify_ocr", input({ timeoutS: 77 }), 1, t.db)).rejects.toThrow();
        await expect(saveDifySettings("dify_agent", input(), 1, t.db)).rejects.toThrow();
      } finally {
        await t.db.execute(`drop trigger fail_audit on settings_audit`);
      }
      expect(await rawRow()).toEqual(before);
      expect(await rawRow("dify_agent")).toBeUndefined();
      expect(await audits()).toHaveLength(1);
    });
  });

  describe("view / getDifySettings", () => {
    it("view không có key hay ciphertext; che chỉ 4 ký tự cuối; có username", async () => {
      await saveDifySettings("dify_ocr", input(), 1, t.db);
      const view = await getDifySettingsView("dify_ocr", t.db);
      expect(view).toMatchObject({
        baseUrl: "https://dify.example.com/v1",
        apiKeyMasked: "app-****wxyz",
        inputVar: "file",
        outputVarMd: "markdown",
        outputVarJson: "json",
        timeoutS: 300,
        retries: 3,
        updatedBy: "admin1",
      });
      expect(view.updatedAt).toBeTruthy();
      const dump = JSON.stringify(view);
      expect(dump).not.toContain(KEY);
      expect(dump).not.toContain("SECRETKEY");
      expect(dump).not.toContain((await rawRow()).apiKeyEnc!);
      expect(Object.keys(view)).not.toContain("apiKey");
      expect(Object.keys(view)).not.toContain("apiKeyEnc");
    });

    it("chưa cấu hình: view rỗng với apiKeyMasked null; getDifySettings ném DifyNotConfiguredError", async () => {
      const view = await getDifySettingsView("dify_agent", t.db);
      expect(view).toMatchObject({ baseUrl: "", apiKeyMasked: null, updatedAt: null, updatedBy: null });
      await expect(getDifySettings("dify_agent", t.db)).rejects.toBeInstanceOf(DifyNotConfiguredError);
    });

    it("hàng không đủ (thiếu key / thiếu URL) -> DifyNotConfiguredError", async () => {
      await t.db.insert(schema.integrationSettings).values({ key: "dify_ocr", baseUrl: "http://x", inputVar: "file", outputVarMd: "m", outputVarJson: "j" });
      await expect(getDifySettings("dify_ocr", t.db)).rejects.toBeInstanceOf(DifyNotConfiguredError);
      await t.db.update(schema.integrationSettings).set({ apiKeyEnc: "v1:a:b:c", baseUrl: "" });
      await expect(getDifySettings("dify_ocr", t.db)).rejects.toBeInstanceOf(DifyNotConfiguredError);
    });

    it("khóa ngắn che hoàn toàn; khóa không có tiền tố app- che kiểu ****abcd", async () => {
      await saveDifySettings("dify_ocr", input({ apiKey: "abc" }), 1, t.db);
      expect((await getDifySettingsView("dify_ocr", t.db)).apiKeyMasked).toBe("****");
      await saveDifySettings("dify_ocr", input({ apiKey: "longkeywithoutprefix1234" }), 1, t.db);
      expect((await getDifySettingsView("dify_ocr", t.db)).apiKeyMasked).toBe("****1234");
    });
  });

  describe("testConnection", () => {
    const saveMock = (o: Partial<DifySettingsInput> = {}) =>
      saveDifySettings("dify_ocr", input({ baseUrl: mock.url, ...o }), 1, t.db);

    it("ok khi /parameters trả 200 và gửi Bearer key", async () => {
      await saveMock();
      const r = await testConnection("dify_ocr", t.db);
      expect(r.ok).toBe(true);
      expect(r.message).not.toContain(KEY);
      expect(mock.params).toHaveLength(1);
      expect(mock.params[0].headers.authorization).toBe(`Bearer ${KEY}`);
    });

    it("401/403 -> API key không hợp lệ", async () => {
      await saveMock();
      for (const status of [401, 403]) {
        mock.onParameters = (req) => ({ status, body: { message: `bad ${req.headers.authorization}` } });
        const r = await testConnection("dify_ocr", t.db);
        expect(r).toEqual({ ok: false, message: "API key không hợp lệ" });
      }
    });

    it("lỗi HTTP khác không rò key", async () => {
      await saveMock();
      mock.onParameters = (req) => ({ status: 500, body: `oops ${req.headers.authorization}` });
      const r = await testConnection("dify_ocr", t.db);
      expect(r.ok).toBe(false);
      expect(r.message).toContain("500");
      expect(r.message).not.toContain(KEY);
      expect(r.message).not.toContain("SECRETKEY");
    });

    it("không theo chuyển hướng 3xx", async () => {
      await saveMock();
      const target = await startDifyMock();
      try {
        mock.onParameters = () => ({ status: 302, headers: { location: `${target.url}/parameters` }, body: {} });
        const r = await testConnection("dify_ocr", t.db);
        expect(r).toEqual({ ok: false, message: "Dify trả về chuyển hướng, kiểm tra lại Base URL" });
        expect(target.params).toHaveLength(0);
      } finally {
        await target.close();
      }
    });

    it("không kết nối được (cổng đóng)", async () => {
      await saveMock({ baseUrl: "http://127.0.0.1:1/v1" });
      const r = await testConnection("dify_ocr", t.db);
      expect(r).toEqual({ ok: false, message: "Không kết nối được tới Dify" });
      expect(r.message).not.toContain(KEY);
    });

    it("chưa cấu hình -> thông báo, không ném", async () => {
      const r = await testConnection("dify_agent", t.db);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/chưa/i);
    });
  });

  describe("API", () => {
    const callAll = (key: string) => [
      () => GET(),
      () => PUT(jsonReq(input()), ctx(key)),
      () => POST(new Request("http://x", { method: "POST" }), ctx(key)),
    ];

    it("401 khi chưa đăng nhập, 403 khi không phải admin — mọi route/method", async () => {
      authMock.mockResolvedValue(null);
      for (const f of callAll("dify_ocr")) expect((await f()).status).toBe(401);
      authMock.mockResolvedValue(session("user"));
      for (const f of callAll("dify_ocr")) expect((await f()).status).toBe(403);
      expect(await rawRow()).toBeUndefined();
    });

    it("tham số key không hợp lệ -> 404 (PUT, POST test)", async () => {
      authMock.mockResolvedValue(session("admin"));
      for (const k of ["nope", "DIFY_OCR", "dify_ocr ", "__proto__"]) {
        expect((await PUT(jsonReq(input()), ctx(k))).status).toBe(404);
        expect((await POST(new Request("http://x", { method: "POST" }), ctx(k))).status).toBe(404);
      }
      expect(await audits()).toHaveLength(0);
    });

    it("PUT lưu, trả view đã che; body JSON sai -> 400; dữ liệu sai -> 400 có code", async () => {
      authMock.mockResolvedValue(session("admin"));
      const res = await PUT(jsonReq(input()), ctx("dify_ocr"));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("SECRETKEY");
      expect(text).not.toContain((await rawRow()).apiKeyEnc!);
      expect(JSON.parse(text).apiKeyMasked).toBe("app-****wxyz");
      expect((await audits())[0].actorId).toBe(1);

      const bad = await PUT(new Request("http://x", { method: "PUT", body: "{nope" }), ctx("dify_ocr"));
      expect(bad.status).toBe(400);
      const bad2 = await PUT(jsonReq(input({ timeoutS: 0 })), ctx("dify_ocr"));
      expect(bad2.status).toBe(400);
      expect((await bad2.json()).code).toBe("invalid_timeout");
      const bad3 = await PUT(jsonReq(input({ apiKey: 123 as never })), ctx("dify_agent"));
      expect(bad3.status).toBe(400);
    });

    it("GET trả cả hai view, không chứa key", async () => {
      authMock.mockResolvedValue(session("admin"));
      await PUT(jsonReq(input()), ctx("dify_ocr"));
      await PUT(jsonReq(input({ apiKey: "app-AGENTKEY-ABCD" })), ctx("dify_agent"));
      const res = await GET();
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const s of [KEY, "AGENTKEY", "SECRETKEY", (await rawRow()).apiKeyEnc!, (await rawRow("dify_agent")).apiKeyEnc!]) {
        expect(text).not.toContain(s);
      }
      const body = JSON.parse(text);
      expect(body.dify_ocr.apiKeyMasked).toBe("app-****wxyz");
      expect(body.dify_agent.apiKeyMasked).toBe("app-****ABCD");
    });

    it("POST test trả {ok,message} không chứa key", async () => {
      authMock.mockResolvedValue(session("admin"));
      await PUT(jsonReq(input({ baseUrl: mock.url })), ctx("dify_ocr"));
      mock.onParameters = (req) => ({ status: 401, body: String(req.headers.authorization) });
      const res = await POST(new Request("http://x", { method: "POST" }), ctx("dify_ocr"));
      const text = await res.text();
      expect(text).not.toContain(KEY);
      expect(JSON.parse(text)).toEqual({ ok: false, message: "API key không hợp lệ" });
      mock.onParameters = () => ({ body: {} });
      const ok = await POST(new Request("http://x", { method: "POST" }), ctx("dify_ocr"));
      expect(await ok.json()).toMatchObject({ ok: true });
    });
  });
});
