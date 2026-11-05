import { describe, expect, it } from "vitest";
import { hasPdfMagic, sanitizeFilename } from "@/server/documents";

describe("sanitizeFilename", () => {
  it("bỏ ký tự điều khiển C0, DEL và C1 (U+0080–U+009F)", () => {
    expect(sanitizeFilename("a\u0000b\u001fc\u007fd\u0080e\u0085f\u009fg.pdf")).toBe("abcdefg.pdf");
  });

  it("bỏ ký tự bidi/hướng (U+202A–202E, U+2066–2069, U+200E/200F)", () => {
    expect(sanitizeFilename("cv‮fdp.exe‬.pdf")).toBe("cvfdp.exe.pdf");
    expect(sanitizeFilename("a⁦b⁧c⁨d⁩e‎f‏g.pdf")).toBe("abcdefg.pdf");
  });

  it("chỉ giữ basename, tên rỗng/./.. -> document.pdf", () => {
    expect(sanitizeFilename("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(sanitizeFilename("a\\b\\c.pdf")).toBe("c.pdf");
    expect(sanitizeFilename("‮\u0080")).toBe("document.pdf");
    expect(sanitizeFilename("..")).toBe("document.pdf");
  });

  it("cắt 255 ký tự, giữ đuôi .pdf, không tách cặp surrogate", () => {
    const emoji = "😀"; // 2 đơn vị UTF-16
    const long = emoji.repeat(200) + ".pdf"; // 400 + 4
    const out = sanitizeFilename(long);
    expect(out.length).toBeLessThanOrEqual(255);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/); // không có high surrogate mồ côi
    expect(out).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/); // không có low surrogate mồ côi
    expect(Array.from(out.slice(0, -4)).every((c) => c === emoji)).toBe(true);
    // không đuôi .pdf
    const noExt = sanitizeFilename(emoji.repeat(200));
    expect(noExt.length).toBeLessThanOrEqual(255);
    expect(noExt).not.toMatch(/[\ud800-\udbff]$/);
  });

  it("idempotent (làm sạch một lần là đủ)", () => {
    const once = sanitizeFilename("x‮\u0085" + "😀".repeat(300) + ".pdf");
    expect(sanitizeFilename(once)).toBe(once);
  });
});

describe("hasPdfMagic", () => {
  it("chỉ cần 5 byte đầu", () => {
    expect(hasPdfMagic(new TextEncoder().encode("%PDF-"))).toBe(true);
    expect(hasPdfMagic(new TextEncoder().encode("%PDF"))).toBe(false);
    expect(hasPdfMagic(new TextEncoder().encode("%pdf-"))).toBe(false);
  });
});
