// Thuần (không import DB/server): dùng được ở worker và test.
import type { Rule } from "@/server/rules";
import { normalize, type Alias } from "./normalize";

export type Extracted = { issuer?: string | null; docType?: string | null };

/**
 * Bước 1: lọc theo cơ quan ban hành (áp bí danh cho cả hai phía); bước 2: lọc theo loại công văn.
 * Chỉ rule `active`. Thiếu/rỗng (sau chuẩn hóa) ở trích xuất hoặc rule -> không khớp.
 * Thứ tự: priority giảm dần, rồi id tăng dần. Không thay đổi đầu vào.
 */
export function matchRules(extracted: Extracted, rules: Rule[], aliases: Alias[]): Rule[] {
  const docType = typeof extracted.docType === "string" ? normalize(extracted.docType) : "";
  if (typeof extracted.issuer !== "string" || docType === "") return [];
  if (normalize(extracted.issuer) === "") return [];

  // Dựng bản đồ bí danh một lần: O(aliases); trùng thì lấy bí danh đứng trước (như canonicalIssuer).
  const map = new Map<string, string>();
  for (const a of aliases) {
    const k = normalize(a.alias);
    if (k === "") continue; // bí danh cũ chuẩn hóa thành rỗng không được ánh xạ chuỗi rỗng
    if (!map.has(k)) map.set(k, normalize(a.canonicalIssuer));
  }
  const canon = (s: string): string => {
    const n = normalize(s);
    return map.get(n) ?? n;
  };

  const issuer = canon(extracted.issuer);
  if (issuer === "") return [];

  return rules
    .filter((r) => {
      if (!r.active) return false;
      if (normalize(r.issuer) === "") return false; // trước canon(): tránh ánh xạ qua khóa rỗng
      const ri = canon(r.issuer);
      if (ri === "" || ri !== issuer) return false;
      const rd = normalize(r.docType);
      return rd !== "" && rd === docType;
    })
    .sort((a, b) => b.priority - a.priority || a.id - b.id);
}
