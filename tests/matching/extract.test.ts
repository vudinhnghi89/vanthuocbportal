import { describe, expect, it } from "vitest";
import { extractFields } from "@/matching/extract";

const NONE = { issuer: null, docType: null, title: null, summary: null };

describe("extractFields", () => {
  it.each([
    ["co_quan_ban_hanh", "issuer"],
    ["issuer", "issuer"],
    ["coquanbanhanh", "issuer"],
    ["coQuanBanHanh", "issuer"],
    ["Cơ quan ban hành", "issuer"],
    ["CO_QUAN_BAN_HANH", "issuer"],
    ["loai_cong_van", "docType"],
    ["doc_type", "docType"],
    ["docType", "docType"],
    ["loai_van_ban", "docType"],
    ["Loại công văn", "docType"],
    ["tieu_de", "title"],
    ["title", "title"],
    ["Tiêu đề", "title"],
    ["tom_tat", "summary"],
    ["summary", "summary"],
    ["trich_yeu", "summary"],
    ["Trích yếu", "summary"],
  ])("key %s -> %s", (key, field) => {
    expect(extractFields({ [key]: "x" })).toEqual({ ...NONE, [field]: "x" });
  });
  it("all fields together", () => {
    expect(
      extractFields({ co_quan_ban_hanh: "A", loai_cong_van: "B", tieu_de: "C", tom_tat: "D", other: "E" }),
    ).toEqual({ issuer: "A", docType: "B", title: "C", summary: "D" });
  });
  it("trims; empty -> null", () => {
    expect(extractFields({ issuer: "  Bộ Y tế \n", title: "   ", summary: "" })).toEqual({
      ...NONE,
      issuer: "Bộ Y tế",
    });
  });
  it("arrays: first non-empty string", () => {
    expect(extractFields({ issuer: ["", "  ", " A ", "B"], title: [1, null, "T"], summary: [] })).toEqual({
      ...NONE,
      issuer: "A",
      title: "T",
    });
    expect(extractFields({ issuer: ["", 3] }).issuer).toBeNull();
  });
  it("non-string values -> null", () => {
    expect(extractFields({ issuer: 5, docType: true, title: { a: 1 }, summary: null })).toEqual(NONE);
  });
  it.each([null, undefined, "str", 42, true, [], [{ issuer: "A" }]])("non-object input %j -> all null", (v) => {
    expect(extractFields(v)).toEqual(NONE);
  });
  it("no nested data lookup", () => {
    expect(extractFields({ data: { issuer: "A" } })).toEqual(NONE);
  });
  it("garbage never throws", () => {
    const shapes: unknown[] = [
      Object.create(null),
      { "": "x", " ": 1 },
      { issuer: Symbol("s") },
      { issuer: [[["a"]]] },
      new Date(),
      new Map(),
      { get issuer() { return "g"; } },
      JSON.parse('{"__proto__": {"issuer": "p"}}'),
      { issuer: () => "f" },
      { [Symbol("k")]: "v" },
    ];
    for (const s of shapes) expect(() => extractFields(s)).not.toThrow();
  });
});
