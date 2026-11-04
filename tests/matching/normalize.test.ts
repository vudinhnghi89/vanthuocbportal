import { describe, expect, it } from "vitest";
import { canonicalIssuer, normalize, type Alias } from "@/matching/normalize";

describe("normalize", () => {
  const cases: [string, string, string][] = [
    ["khoảng trắng đầu/cuối", "  Bộ Y Tế ", "bo y te"],
    ["chữ hoa", "BỘ Y TẾ", "bo y te"],
    ["không dấu", "bo y te", "bo y te"],
    ["đ/Đ", "Đà Nẵng", "da nang"],
    ["Đ hoa", "ĐẠI HỌC", "dai hoc"],
    ["dấu chấm cuối", "UBND tỉnh Nghệ An.", "ubnd tinh nghe an"],
    ["gạch nối và gạch chéo", "Sở Y-tế/Hà Nội", "so y te ha noi"],
    ["giữ chữ số", "Số 12/2024", "so 12 2024"],
    ["ngoặc và nháy", "(“Bộ”) 'Y' \"Tế\"", "bo y te"],
    ["NBSP", "Bộ Y Tế", "bo y te"],
    ["khoảng trắng Unicode khác", "Bộ Y　Tế ", "bo y te"],
    ["ký tự zero-width", "B​ộ‌ Y‍ T⁠ế﻿", "bo y te"],
    ["soft hyphen", "Bộ Y Tế­", "bo y te"],
    ["tab và xuống dòng", "Bộ\tY\r\nTế\n", "bo y te"],
    ["chuỗi rỗng", "", ""],
    ["chỉ khoảng trắng", " \t\n ", ""],
    ["chỉ dấu câu", "..,;-/()\"'", ""],
    ["chỉ ký tự vô hình", "​﻿­", ""],
    ["İ có dấu chấm", "İstanbul", "istanbul"],
  ];
  it.each(cases)("%s", (_n, input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  it("NFC và NFD cho cùng kết quả", () => {
    for (const s of ["Bộ Y Tế", "Đà Nẵng", "Nguyễn Thị Minh Khai", "Ủy ban nhân dân"]) {
      expect(normalize(s.normalize("NFC"))).toBe(normalize(s.normalize("NFD")));
    }
    expect(normalize("Bộ Y Tế".normalize("NFD"))).toBe("bo y te");
    expect(normalize("Bộ Y Tế".normalize("NFC"))).toBe("bo y te");
  });

  it("idempotent", () => {
    const samples = ["  Bộ Y Tế ", "Sở Y-tế/Hà Nội", "Số 12/2024", "İstanbul", "​..", "Đ-Ð", "", "a  b c"];
    for (const s of samples) expect(normalize(normalize(s))).toBe(normalize(s));
  });

  it("đầu vào dài 1e5 ký tự xử lý < 100ms", () => {
    const s = "Bộ Y-Tế/Đà Nẵng, ".repeat(Math.ceil(100_000 / 17)).slice(0, 100_000);
    const t0 = performance.now();
    normalize(s);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe("canonicalIssuer", () => {
  const aliases: Alias[] = [
    { alias: "BYT", canonicalIssuer: "Bộ Y Tế" },
    { alias: "UBND Tp. Hà Nội", canonicalIssuer: "Ủy ban nhân dân thành phố Hà Nội" },
  ];
  it("bí danh -> tên chuẩn đã chuẩn hóa", () => {
    expect(canonicalIssuer("BYT", aliases)).toBe("bo y te");
  });
  it("không phân biệt hoa thường / dấu / dấu câu", () => {
    expect(canonicalIssuer(" byt. ", aliases)).toBe("bo y te");
    expect(canonicalIssuer("ubnd TP Hà Nội", aliases)).toBe("uy ban nhan dan thanh pho ha noi");
  });
  it("không có bí danh -> chỉ chuẩn hóa", () => {
    expect(canonicalIssuer("Bộ Y Tế", aliases)).toBe("bo y te");
    expect(canonicalIssuer("Sở Y-tế", aliases)).toBe("so y te");
    expect(canonicalIssuer("BYT", [])).toBe("byt");
  });
  it("một bước, không nối chuỗi; alias trùng canonical vô hại; trùng -> theo thứ tự", () => {
    const chain: Alias[] = [
      { alias: "A", canonicalIssuer: "B" },
      { alias: "B", canonicalIssuer: "C" },
    ];
    expect(canonicalIssuer("A", chain)).toBe("b");
    expect(canonicalIssuer("X", [{ alias: "X", canonicalIssuer: "x." }])).toBe("x");
    expect(
      canonicalIssuer("Q", [
        { alias: "Q", canonicalIssuer: "first" },
        { alias: "q.", canonicalIssuer: "second" },
      ]),
    ).toBe("first");
  });
});
