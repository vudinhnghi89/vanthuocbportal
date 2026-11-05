import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import { documents } from "@/db/schema";
import { extractFields } from "@/matching/extract";
import { UUID_RE } from "./document-detail";
import type { DbLike } from "./status";

export type RuleDraft = {
  issuer: string;
  docType: string;
  title: string;
  summary: string;
  mainUnitId: number | null;
  infoUnitId: number | null;
  documentId: string;
  filename: string;
};

/**
 * Bản nháp rule từ một văn bản: các trường lấy từ JSON trích xuất; đơn vị chỉ lấy khi
 * văn bản đã được người phân loại thủ công (needs_manual=false và match_method='none').
 * Không trả về đường dẫn tệp hay nội dung markdown.
 */
export async function getRuleDraftFromDocument(documentId: string, db: DbLike = defaultDb): Promise<RuleDraft | null> {
  if (!UUID_RE.test(documentId)) return null;
  const [doc] = await db
    .select({
      id: documents.id,
      filename: documents.filename,
      extracted: documents.extracted,
      needsManual: documents.needsManual,
      matchMethod: documents.matchMethod,
      mainUnitId: documents.mainUnitId,
      infoUnitId: documents.infoUnitId,
    })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc) return null;
  const f = extractFields(doc.extracted);
  const manual = !doc.needsManual && doc.matchMethod === "none";
  return {
    issuer: f.issuer ?? "",
    docType: f.docType ?? "",
    title: f.title ?? "",
    summary: f.summary ?? "",
    mainUnitId: manual ? doc.mainUnitId : null,
    infoUnitId: manual ? doc.infoUnitId : null,
    documentId: doc.id,
    filename: doc.filename,
  };
}
