// Hợp đồng JSON của OCR. Thuần, không bao giờ ném lỗi.
import { normalize } from "./normalize";

export type ExtractedFields = {
  issuer: string | null;
  docType: string | null;
  title: string | null;
  summary: string | null;
};

const KEYS: Record<keyof ExtractedFields, string[]> = {
  issuer: ["co_quan_ban_hanh", "issuer", "coquanbanhanh"],
  docType: ["loai_cong_van", "doc_type", "loai_van_ban"],
  title: ["tieu_de", "title"],
  summary: ["tom_tat", "summary", "trich_yeu"],
};

const squash = (k: string): string => normalize(k).replace(/ /g, "");

const LOOKUP = new Map<string, keyof ExtractedFields>();
for (const [field, names] of Object.entries(KEYS) as [keyof ExtractedFields, string[]][]) {
  for (const n of names) LOOKUP.set(squash(n), field);
}

function text(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) {
    for (const el of v) {
      if (typeof el === "string" && el.trim()) return el.trim();
    }
  }
  return null;
}

export function extractFields(json: unknown): ExtractedFields {
  const out: ExtractedFields = { issuer: null, docType: null, title: null, summary: null };
  try {
    if (typeof json !== "object" || json === null || Array.isArray(json)) return out;
    for (const key of Object.keys(json)) {
      const field = LOOKUP.get(squash(key));
      if (!field || out[field] !== null) continue;
      out[field] = text((json as Record<string, unknown>)[key]);
    }
  } catch {
    // dữ liệu bất thường: trả về những gì đã đọc được
  }
  return out;
}
