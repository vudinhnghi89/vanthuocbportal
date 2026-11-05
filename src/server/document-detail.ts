import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { db as defaultDb } from "@/db/client";
import { documentEvents, documents, units, users } from "@/db/schema";
import type { Status } from "@/lib/status";
import { sanitizeFilename } from "./documents";
import { resolveInsideDataDir } from "./storage";
import { DOC_EVENTS_CHANNEL, type DbLike } from "./status";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MARKDOWN_MAX_CHARS = 100_000;
const MARKDOWN_MAX_BYTES = 400 * 1024;
const INT4_MAX = 2147483647;

type UnitRef = { id: number; name: string };
export type DocumentDetail = {
  id: string;
  filename: string;
  status: Status;
  error: string | null;
  needsManual: boolean;
  matchMethod: "single" | "agent" | "none" | null;
  matchedRuleId: number | null;
  mainUnit: UnitRef | null;
  infoUnit: UnitRef | null;
  uploadedBy: string | null;
  createdAt: string;
  updatedAt: string;
  extracted: unknown;
  markdown: string;
  markdownTruncated: boolean;
  hasPdf: boolean;
  events: { at: string; from: Status | null; to: Status; actor: string | null; note: string | null }[];
};

const unitRef = (id: number | null, name: string | null): UnitRef | null =>
  id !== null && name !== null ? { id, name } : null;

/** Đọc tối đa 400 KB đầu của markdown (chỉ khi nằm trong DATA_DIR), cắt còn 100_000 ký tự. */
async function readMarkdown(mdPath: string | null): Promise<{ text: string; truncated: boolean }> {
  const real = mdPath ? await resolveInsideDataDir(mdPath, "md") : null;
  if (!real) return { text: "", truncated: false };
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(real, "r");
    const size = (await handle.stat()).size;
    const buf = Buffer.alloc(Math.min(size, MARKDOWN_MAX_BYTES));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    // Cắt giữa ký tự đa byte có thể sinh U+FFFD ở cuối khi file lớn hơn mức đọc.
    if (size > bytesRead) text = text.replace(/\uFFFD+$/, "");
    const truncated = size > bytesRead || text.length > MARKDOWN_MAX_CHARS;
    return { text: text.slice(0, MARKDOWN_MAX_CHARS), truncated };
  } catch {
    return { text: "", truncated: false };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function pdfExists(pdfPath: string): Promise<boolean> {
  const real = await resolveInsideDataDir(pdfPath, "pdf");
  if (!real) return false;
  try {
    return (await fsp.stat(real)).isFile();
  } catch {
    return false;
  }
}

/** Chi tiết văn bản cho UI/API; không bao giờ chứa pdf_path/md_path. null nếu không tồn tại. */
export async function getDocumentDetail(id: string, db: DbLike = defaultDb): Promise<DocumentDetail | null> {
  if (!UUID_RE.test(id)) return null;
  const main = alias(units, "main_unit");
  const info = alias(units, "info_unit");
  const [row] = await db
    .select({
      id: documents.id,
      filename: documents.filename,
      status: documents.status,
      error: documents.error,
      needsManual: documents.needsManual,
      matchMethod: documents.matchMethod,
      matchedRuleId: documents.matchedRuleId,
      mainId: main.id,
      mainName: main.name,
      infoId: info.id,
      infoName: info.name,
      uploadedBy: users.username,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
      extracted: documents.extracted,
      mdPath: documents.mdPath,
      pdfPath: documents.pdfPath,
    })
    .from(documents)
    .leftJoin(main, eq(main.id, documents.mainUnitId))
    .leftJoin(info, eq(info.id, documents.infoUnitId))
    .leftJoin(users, eq(users.id, documents.uploadedBy))
    .where(eq(documents.id, id));
  if (!row) return null;

  const actor = alias(users, "actor");
  const evs = await db
    .select({
      at: documentEvents.at,
      from: documentEvents.fromStatus,
      to: documentEvents.toStatus,
      actor: actor.username,
      note: documentEvents.note,
    })
    .from(documentEvents)
    .leftJoin(actor, eq(actor.id, documentEvents.actorId))
    .where(eq(documentEvents.documentId, id))
    .orderBy(asc(documentEvents.at), asc(documentEvents.id));

  const md = await readMarkdown(row.mdPath);
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    error: row.error,
    needsManual: row.needsManual,
    matchMethod: row.matchMethod,
    matchedRuleId: row.matchedRuleId,
    mainUnit: unitRef(row.mainId, row.mainName),
    infoUnit: unitRef(row.infoId, row.infoName),
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    extracted: row.extracted ?? null,
    markdown: md.text,
    markdownTruncated: md.truncated,
    hasPdf: await pdfExists(row.pdfPath),
    events: evs.map((e) => ({ at: e.at.toISOString(), from: e.from, to: e.to, actor: e.actor, note: e.note })),
  };
}

export type PdfFile = { path: string; filename: string; size: number };

/** PDF gốc để phát lại; null nếu văn bản không có, tệp mất hoặc đường dẫn nằm ngoài DATA_DIR/pdf. */
export async function getDocumentPdf(id: string, db: DbLike = defaultDb): Promise<PdfFile | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .select({ pdfPath: documents.pdfPath, filename: documents.filename })
    .from(documents)
    .where(eq(documents.id, id));
  const p = row ? await resolveInsideDataDir(row.pdfPath, "pdf") : null;
  if (!row || !p) return null;
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return null;
    return { path: p, filename: row.filename, size: st.size };
  } catch {
    return null;
  }
}

/** Content-Disposition inline an toàn: tên ASCII dự phòng + filename* UTF-8 đã mã hóa. */
export function inlineDisposition(rawName: string): string {
  const clean = sanitizeFilename(rawName);
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%;]/g, "_");
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Luồng Web từ tệp (không nạp cả tệp vào bộ nhớ). */
export function streamFile(filePath: string): ReadableStream<Uint8Array> {
  const node = fs.createReadStream(filePath);
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      node.on("data", (chunk) => {
        if (closed) return;
        controller.enqueue(new Uint8Array(chunk as Buffer));
        if (controller.desiredSize !== null && controller.desiredSize <= 0) node.pause();
      });
      node.on("end", () => {
        if (closed) return;
        closed = true;
        controller.close();
      });
      node.on("error", (err) => {
        if (closed) return;
        closed = true;
        controller.error(err);
      });
    },
    pull() {
      node.resume();
    },
    cancel() {
      closed = true;
      node.destroy();
    },
  });
}

export class ClassifyError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "ClassifyError";
  }
}

const isUnitId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= INT4_MAX;

export type ClassifyInput = { mainUnitId?: unknown; infoUnitId?: unknown };

/** Phân loại thủ công: một giao dịch, khóa dòng; ghi event + NOTIFY cùng giao dịch. */
export async function classifyDocument(
  id: string,
  input: ClassifyInput,
  actorId: number,
  db: DbLike = defaultDb,
) {
  if (!UUID_RE.test(id)) throw new ClassifyError(400, "id không hợp lệ");
  if (!isUnitId(input.mainUnitId)) throw new ClassifyError(400, "Vui lòng chọn đơn vị xử lý chính hợp lệ");
  const infoId = input.infoUnitId ?? null;
  if (infoId !== null && !isUnitId(infoId)) throw new ClassifyError(400, "Đơn vị nhận thông tin không hợp lệ");
  const mainId = input.mainUnitId;

  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ status: documents.status, needsManual: documents.needsManual })
      .from(documents)
      .where(eq(documents.id, id))
      .for("update");
    if (!doc) throw new ClassifyError(404, "Không tìm thấy văn bản");
    if (!doc.needsManual) throw new ClassifyError(409, "Văn bản này không cần phân loại thủ công");
    if (doc.status !== "classified") throw new ClassifyError(409, "Văn bản chưa ở trạng thái Hoàn tất phân loại");

    const wanted = infoId === null || infoId === mainId ? [mainId] : [mainId, infoId];
    const found = await tx
      .select({ id: units.id, name: units.name })
      .from(units)
      .where(and(inArray(units.id, wanted), eq(units.active, true)));
    const main = found.find((u) => u.id === mainId);
    const info = infoId === null ? null : found.find((u) => u.id === infoId);
    if (!main) throw new ClassifyError(400, "Đơn vị xử lý chính không tồn tại hoặc đã ngừng hoạt động");
    if (infoId !== null && !info) throw new ClassifyError(400, "Đơn vị nhận thông tin không tồn tại hoặc đã ngừng hoạt động");

    await tx
      .update(documents)
      .set({ mainUnitId: main.id, infoUnitId: info?.id ?? null, needsManual: false, updatedAt: sql`clock_timestamp()` as never })
      .where(eq(documents.id, id));
    await tx.insert(documentEvents).values({
      documentId: id,
      fromStatus: "classified",
      toStatus: "classified",
      actorId,
      note: `Phân loại thủ công: ${main.name} / ${info?.name ?? "—"}`,
      at: sql`clock_timestamp()` as never,
    });
    await tx.execute(
      sql`select pg_notify(${DOC_EVENTS_CHANNEL}, ${JSON.stringify({ documentId: id, from: "classified", to: "classified" })})`,
    );
    return { id, status: "classified" as const, needsManual: false as const, mainUnit: main, infoUnit: info ?? null };
  });
}
