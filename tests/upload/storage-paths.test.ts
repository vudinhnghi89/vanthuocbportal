import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deletePdf, isInsideDataDir, savePdf } from "@/server/storage";

describe("storage path safety (symlink)", () => {
  let base: string;
  let data: string;
  let outside: string;
  let prev: string | undefined;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vtp-store-")));
    data = path.join(base, "data");
    outside = path.join(base, "outside");
    fs.mkdirSync(path.join(data, "pdf"), { recursive: true });
    fs.mkdirSync(path.join(data, "md"), { recursive: true });
    fs.mkdirSync(outside);
    prev = process.env.DATA_DIR;
    process.env.DATA_DIR = data;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("tệp thường trong DATA_DIR: true; tệp chưa tồn tại trong thư mục thật: true", async () => {
    const p = await savePdf(Buffer.from("%PDF-1.4"));
    expect(await isInsideDataDir(p, "pdf")).toBe(true);
    expect(await isInsideDataDir(path.join(data, "pdf", "chua-co.pdf"), "pdf")).toBe(true);
  });

  it("symlink tệp trong DATA_DIR trỏ ra ngoài: false, deletePdf từ chối và không xóa tệp ngoài", async () => {
    const target = path.join(outside, "secret.pdf");
    fs.writeFileSync(target, "x");
    const link = path.join(data, "pdf", "link.pdf");
    fs.symlinkSync(target, link);
    expect(await isInsideDataDir(link, "pdf")).toBe(false);
    expect(await isInsideDataDir(link)).toBe(false);
    await expect(deletePdf(link)).rejects.toThrow();
    expect(fs.existsSync(target)).toBe(true);
  });

  it("symlink thư mục trong DATA_DIR trỏ ra ngoài: tệp có sẵn và tệp chưa tồn tại đều bị từ chối", async () => {
    fs.writeFileSync(path.join(outside, "a.pdf"), "x");
    fs.symlinkSync(outside, path.join(data, "pdf", "dir"));
    expect(await isInsideDataDir(path.join(data, "pdf", "dir", "a.pdf"), "pdf")).toBe(false);
    expect(await isInsideDataDir(path.join(data, "pdf", "dir", "new.pdf"), "pdf")).toBe(false);
    await expect(deletePdf(path.join(data, "pdf", "dir", "a.pdf"))).rejects.toThrow();
    expect(fs.existsSync(path.join(outside, "a.pdf"))).toBe(true);
  });

  it("symlink trỏ tới tệp khác BÊN TRONG pdf/: chấp nhận", async () => {
    const p = await savePdf(Buffer.from("%PDF-1.4"));
    const link = path.join(data, "pdf", "alias.pdf");
    fs.symlinkSync(p, link);
    expect(await isInsideDataDir(link, "pdf")).toBe(true);
  });

  it("DATA_DIR là symlink: so sánh bằng realpath nên vẫn nhận tệp hợp lệ", async () => {
    const alias = path.join(base, "data-alias");
    fs.symlinkSync(data, alias);
    process.env.DATA_DIR = alias;
    const p = await savePdf(Buffer.from("%PDF-1.4"));
    expect(await isInsideDataDir(p, "pdf")).toBe(true);
    await deletePdf(p);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("deletePdf chỉ trong DATA_DIR/pdf: md/ và gốc DATA_DIR bị từ chối", async () => {
    const md = path.join(data, "md", "x.md");
    const root = path.join(data, "y.pdf");
    fs.writeFileSync(md, "x");
    fs.writeFileSync(root, "x");
    await expect(deletePdf(md)).rejects.toThrow();
    await expect(deletePdf(root)).rejects.toThrow();
    expect(fs.existsSync(md) && fs.existsSync(root)).toBe(true);
  });

  it("deletePdf: tệp không tồn tại thì bỏ qua", async () => {
    await expect(deletePdf(path.join(data, "pdf", "khong-co.pdf"))).resolves.toBeUndefined();
  });

  it("thư mục gốc chưa tồn tại: false, không ném", async () => {
    fs.rmSync(path.join(data, "md"), { recursive: true });
    expect(await isInsideDataDir(path.join(data, "md", "a.md"), "md")).toBe(false);
  });
});
