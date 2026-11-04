import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as schema from "@/db/schema";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";

const authMock = vi.fn();
vi.mock("@/auth/config", () => ({ auth: () => authMock() }));
const holder = vi.hoisted(() => ({ db: undefined as unknown, failEnqueue: false }));
vi.mock("@/db/client", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/worker/queue", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/worker/queue")>();
  return {
    ...orig,
    enqueueOcr: (id: string) => {
      if (holder.failEnqueue) return Promise.reject(new Error("secret internal: connection refused 10.0.0.5"));
      return orig.enqueueOcr(id);
    },
  };
});

import { POST } from "@/app/api/documents/route";
import { dataDir, deletePdf, savePdf } from "@/server/storage";
import { stopBoss } from "@/worker/queue";

const mode = dbSuiteMode(process.env);
const MB = 1024 * 1024;
const session = (id = 7) => ({ user: { id, username: "u", role: "user", active: true }, expires: "2099-01-01" });

function pdfBytes(size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set(new TextEncoder().encode("%PDF-1.7\n"));
  b.fill(0x41, 9);
  return b;
}
function req(files: { name: string; data: Uint8Array | string; type?: string }[]): Request {
  const fd = new FormData();
  for (const f of files) fd.append("files", new File([f.data as BlobPart], f.name, { type: f.type ?? "application/pdf" }));
  return new Request("http://localhost/api/documents", { method: "POST", body: fd });
}
const pdfFiles = () => fs.readdirSync(path.join(dataDir(), "pdf"));

describe.skipIf(mode !== "run")("upload", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tmp: string;
  let prevDb: string | undefined;
  let prevData: string | undefined;

  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
    prevDb = process.env.DATABASE_URL;
    prevData = process.env.DATA_DIR;
    process.env.DATABASE_URL = t.url; // pg-boss singleton dùng DB tạm
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vtp-upload-"));
    process.env.DATA_DIR = tmp;
    await t.db.insert(schema.users).values({ id: 7, username: "u7", passwordHash: "x", role: "user" });
  });
  afterAll(async () => {
    try {
      await stopBoss(2000);
    } finally {
      process.env.DATABASE_URL = prevDb;
      if (prevData === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevData;
      await t?.cleanup();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    authMock.mockReset();
    authMock.mockResolvedValue(session());
    holder.failEnqueue = false;
    await t.db.delete(schema.documents);
    fs.rmSync(path.join(tmp, "pdf"), { recursive: true, force: true });
  });

  it("PDF hợp lệ -> 201, dòng queued, file giống hệt, event, job pg-boss", async () => {
    const data = pdfBytes(1000);
    const res = await POST(req([{ name: "Công văn 1.pdf", data }]));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ filename: "Công văn 1.pdf", ok: true, status: "queued" });
    const id = body.results[0].id;
    const [doc] = await t.db.select().from(schema.documents).where(eq(schema.documents.id, id));
    expect(doc).toMatchObject({ status: "queued", uploadedBy: 7, filename: "Công văn 1.pdf" });
    expect(path.isAbsolute(doc.pdfPath)).toBe(true);
    expect(Buffer.compare(fs.readFileSync(doc.pdfPath), Buffer.from(data))).toBe(0);
    const ev = await t.db.select().from(schema.documentEvents).where(eq(schema.documentEvents.documentId, id));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ fromStatus: null, toStatus: "queued", actorId: 7 });
    const jobs = await t.db.execute(sql`select 1 from pgboss.job where name = 'ocr' and singleton_key = ${id}`);
    expect(jobs.rows).toHaveLength(1);
    const mode = fs.statSync(doc.pdfPath).mode & 0o777;
    expect(mode).toBe(0o640);
  });

  it("file văn bản đổi đuôi .pdf -> not_pdf, không dòng, không file", async () => {
    const res = await POST(req([{ name: "fake.pdf", data: "hello world, not a pdf" }]));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ ok: false, code: "not_pdf" });
    expect(typeof body.results[0].error).toBe("string");
    expect(await t.db.select().from(schema.documents)).toHaveLength(0);
    expect(fs.existsSync(path.join(tmp, "pdf")) ? pdfFiles() : []).toHaveLength(0);
  });

  it("file rỗng -> empty", async () => {
    const res = await POST(req([{ name: "e.pdf", data: new Uint8Array(0) }]));
    expect(res.status).toBe(400);
    expect((await res.json()).results[0]).toMatchObject({ ok: false, code: "empty" });
  });

  it("50MB+1 byte -> too_large (413 khi chỉ một file); đúng 50MB -> chấp nhận", async () => {
    const big = pdfBytes(50 * MB + 1);
    const res = await POST(req([{ name: "big.pdf", data: big }]));
    expect(res.status).toBe(413);
    expect((await res.json()).results[0]).toMatchObject({ ok: false, code: "too_large" });
    expect(await t.db.select().from(schema.documents)).toHaveLength(0);

    const ok = await POST(req([{ name: "edge.pdf", data: pdfBytes(50 * MB) }]));
    expect(ok.status).toBe(201);
    expect((await ok.json()).results[0].ok).toBe(true);
  }, 60_000);

  it("đuôi .txt với nội dung PDF -> bad_extension", async () => {
    const res = await POST(req([{ name: "a.txt", data: pdfBytes() }]));
    expect(res.status).toBe(400);
    expect((await res.json()).results[0]).toMatchObject({ ok: false, code: "bad_extension" });
  });

  it("đuôi .PDF viết hoa được chấp nhận", async () => {
    const res = await POST(req([{ name: "A.PDF", data: pdfBytes() }]));
    expect(res.status).toBe(201);
  });

  it("tên chứa ../, ..\\ và NUL: đường dẫn lưu nằm trong DATA_DIR với tên uuid, filename được làm sạch", async () => {
    const res = await POST(
      req([
        { name: "../../etc/passwd.pdf", data: pdfBytes() },
        { name: "..\\..\\x.pdf", data: pdfBytes() },
        { name: "a\0b.pdf", data: pdfBytes() },
      ]),
    );
    expect(res.status).toBe(201);
    const { results } = await res.json();
    expect(results.map((r: { filename: string }) => r.filename)).toEqual(["passwd.pdf", "x.pdf", "ab.pdf"]);
    const docs = await t.db.select().from(schema.documents);
    expect(docs).toHaveLength(3);
    for (const d of docs) {
      expect(d.pdfPath.startsWith(path.join(tmp, "pdf") + path.sep)).toBe(true);
      expect(path.basename(d.pdfPath)).toMatch(/^[0-9a-f-]{36}\.pdf$/);
      expect(d.filename).not.toMatch(/[\\/\0]/);
    }
    expect(fs.existsSync("/etc/passwd.pdf")).toBe(false);
  });

  it("lô hỗn hợp: file tốt được xử lý, file xấu báo lỗi, tổng 201", async () => {
    const res = await POST(
      req([
        { name: "good.pdf", data: pdfBytes() },
        { name: "bad.pdf", data: "nope" },
      ]),
    );
    expect(res.status).toBe(201);
    const { results } = await res.json();
    expect(results[0]).toMatchObject({ filename: "good.pdf", ok: true });
    expect(results[1]).toMatchObject({ filename: "bad.pdf", ok: false, code: "not_pdf" });
    expect(await t.db.select().from(schema.documents)).toHaveLength(1);
    expect(pdfFiles()).toHaveLength(1);
  });

  it("tất cả lỗi (nhiều file) -> 400", async () => {
    const res = await POST(req([{ name: "a.pdf", data: "x" }, { name: "b.pdf", data: new Uint8Array(0) }]));
    expect(res.status).toBe(400);
  });

  it("chưa đăng nhập -> 401", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(req([{ name: "a.pdf", data: pdfBytes() }]));
    expect(res.status).toBe(401);
  });

  it("enqueue lỗi -> xóa dòng và file, báo lỗi chung chung", async () => {
    holder.failEnqueue = true;
    const res = await POST(req([{ name: "a.pdf", data: pdfBytes() }]));
    expect(res.status).toBe(400);
    const r = (await res.json()).results[0];
    expect(r).toMatchObject({ ok: false, code: "internal" });
    expect(JSON.stringify(r)).not.toContain("10.0.0.5");
    expect(await t.db.select().from(schema.documents)).toHaveLength(0);
    expect(await t.db.select().from(schema.documentEvents)).toHaveLength(0);
    expect(pdfFiles()).toHaveLength(0);
  });

  it(">10 file -> 400, không xử lý", async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.pdf`, data: pdfBytes() }));
    const res = await POST(req(files));
    expect(res.status).toBe(400);
    expect(await t.db.select().from(schema.documents)).toHaveLength(0);
  });

  it("không có file -> 400", async () => {
    const res = await POST(new Request("http://localhost/api/documents", { method: "POST", body: new FormData() }));
    expect(res.status).toBe(400);
  });

  it("Content-Length quá lớn -> 413 mà không đọc body", async () => {
    const r = req([{ name: "a.pdf", data: pdfBytes() }]);
    const headers = new Headers({ "content-length": String(10 * 50 * MB + 5 * MB), "content-type": "multipart/form-data; boundary=x" });
    const big = new Request(r.url, { method: "POST", body: "x", headers });
    const spy = vi.spyOn(big, "formData");
    const res = await POST(big);
    expect(res.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("storage", () => {
  let tmp: string;
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env.DATA_DIR;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vtp-storage-"));
    process.env.DATA_DIR = tmp;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("savePdf ghi tệp uuid, quyền 0o640, thư mục 0o750; không để lại tệp tạm", async () => {
    const p = await savePdf(Buffer.from("%PDF-1.4 x"));
    expect(path.dirname(p)).toBe(path.join(tmp, "pdf"));
    expect(fs.statSync(p).mode & 0o777).toBe(0o640);
    expect(fs.statSync(path.join(tmp, "pdf")).mode & 0o777).toBe(0o750);
    expect(fs.readdirSync(path.join(tmp, "pdf"))).toEqual([path.basename(p)]);
  });

  it("deletePdf xóa tệp trong DATA_DIR và từ chối đường dẫn ngoài", async () => {
    const p = await savePdf(Buffer.from("%PDF-1.4 x"));
    await deletePdf(p);
    expect(fs.existsSync(p)).toBe(false);
    const outside = path.join(os.tmpdir(), `vtp-outside-${Date.now()}.pdf`);
    fs.writeFileSync(outside, "x");
    await expect(deletePdf(outside)).rejects.toThrow();
    await expect(deletePdf(path.join(tmp, "..", path.basename(outside)))).rejects.toThrow();
    await expect(deletePdf(tmp + "-evil/x.pdf")).rejects.toThrow();
    expect(fs.existsSync(outside)).toBe(true);
    fs.rmSync(outside);
  });
});
