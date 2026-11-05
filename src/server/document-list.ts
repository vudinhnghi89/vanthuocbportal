import { and, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db as defaultDb } from "@/db/client";
import { documents, units, users } from "@/db/schema";
import { STATUSES, type Status } from "@/lib/status";
import type { DbLike } from "./status";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 1_000_000;
const INT4_MAX = 2_147_483_647;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Ho_Chi_Minh = UTC+7, không có giờ mùa hè

export type DocumentFilters = {
  statuses?: Status[];
  unitId?: number;
  needsManual?: boolean;
  /** Bao gồm (>=). */
  from?: Date;
  /** Không bao gồm (<): 00:00 của ngày sau ngày "đến". */
  toExclusive?: Date;
  q?: string;
  page: number;
  pageSize: number;
};

export type DocumentListItem = {
  id: string;
  filename: string;
  status: Status;
  error: string | null;
  needsManual: boolean;
  matchMethod: "single" | "agent" | "none" | null;
  matchedRuleId: number | null;
  mainUnit: { id: number; name: string } | null;
  infoUnit: { id: number; name: string } | null;
  uploadedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ParseResult = { ok: true; filters: DocumentFilters } | { ok: false; error: string };
const bad = (error: string): ParseResult => ({ ok: false, error });

/** Ngày YYYY-MM-DD (lịch hợp lệ) -> mốc 00:00 giờ Việt Nam của ngày đó (+ offset ngày). */
function vnDayStart(s: string, plusDays = 0): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return new Date(Date.UTC(y, mo - 1, d + plusDays) - VN_OFFSET_MS);
}

const digits = /^\d+$/;

export function parseListQuery(sp: URLSearchParams): ParseResult {
  const filters: DocumentFilters = { page: 1, pageSize: DEFAULT_PAGE_SIZE };

  const rawStatus = sp.getAll("status").filter((v) => v !== "").join(",");
  if (rawStatus) {
    const parts = rawStatus.split(",").map((p) => p.trim());
    if (!parts.every((p) => (STATUSES as readonly string[]).includes(p))) return bad("Trạng thái không hợp lệ");
    filters.statuses = [...new Set(parts)] as Status[];
  }

  const unit = sp.get("unit");
  if (unit) {
    if (!digits.test(unit) || unit.length > 10 || Number(unit) < 1 || Number(unit) > INT4_MAX) {
      return bad("Mã đơn vị không hợp lệ");
    }
    filters.unitId = Number(unit);
  }

  const nm = sp.get("needsManual");
  if (nm) {
    if (nm !== "true" && nm !== "false") return bad("Giá trị needsManual không hợp lệ");
    filters.needsManual = nm === "true";
  }

  const from = sp.get("from");
  const to = sp.get("to");
  if (from) {
    const d = vnDayStart(from);
    if (!d) return bad("Ngày bắt đầu không hợp lệ (định dạng YYYY-MM-DD)");
    filters.from = d;
  }
  if (to) {
    const d = vnDayStart(to, 1);
    if (!d) return bad("Ngày kết thúc không hợp lệ (định dạng YYYY-MM-DD)");
    filters.toExclusive = d;
  }
  if (from && to && filters.from! >= filters.toExclusive!) return bad("Ngày bắt đầu phải trước hoặc bằng ngày kết thúc");

  const q = sp.get("q")?.trim();
  if (q) filters.q = q.slice(0, 200);

  const page = sp.get("page");
  if (page) {
    if (!digits.test(page) || Number(page) < 1 || Number(page) > MAX_PAGE) return bad("Trang không hợp lệ");
    filters.page = Number(page);
  }
  const size = sp.get("pageSize");
  if (size) {
    if (!digits.test(size) || Number(size) < 1 || Number(size) > MAX_PAGE_SIZE) {
      return bad(`Số dòng mỗi trang phải từ 1 đến ${MAX_PAGE_SIZE}`);
    }
    filters.pageSize = Number(size);
  }
  return { ok: true, filters };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listDocuments(
  f: DocumentFilters,
  db: DbLike = defaultDb,
): Promise<{ items: DocumentListItem[]; total: number; page: number; pageSize: number }> {
  const conds: (SQL | undefined)[] = [
    f.statuses ? inArray(documents.status, f.statuses) : undefined,
    f.unitId !== undefined ? or(eq(documents.mainUnitId, f.unitId), eq(documents.infoUnitId, f.unitId)) : undefined,
    f.needsManual ? eq(documents.needsManual, true) : undefined,
    f.from ? gte(documents.createdAt, f.from) : undefined,
    f.toExclusive ? lt(documents.createdAt, f.toExclusive) : undefined,
    f.q ? ilike(documents.filename, `%${escapeLike(f.q)}%`) : undefined,
  ];
  const where = and(...conds);
  const mainUnit = alias(units, "main_unit");
  const infoUnit = alias(units, "info_unit");

  const [rows, [{ n }]] = await Promise.all([
    db
      .select({
        id: documents.id,
        filename: documents.filename,
        status: documents.status,
        error: documents.error,
        needsManual: documents.needsManual,
        matchMethod: documents.matchMethod,
        matchedRuleId: documents.matchedRuleId,
        mainUnitId: mainUnit.id,
        mainUnitName: mainUnit.name,
        infoUnitId: infoUnit.id,
        infoUnitName: infoUnit.name,
        uploadedBy: users.username,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .leftJoin(mainUnit, eq(documents.mainUnitId, mainUnit.id))
      .leftJoin(infoUnit, eq(documents.infoUnitId, infoUnit.id))
      .leftJoin(users, eq(documents.uploadedBy, users.id))
      .where(where)
      .orderBy(desc(documents.createdAt), desc(documents.id))
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(documents).where(where),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      status: r.status,
      error: r.error,
      needsManual: r.needsManual,
      matchMethod: r.matchMethod,
      matchedRuleId: r.matchedRuleId,
      mainUnit: r.mainUnitId !== null && r.mainUnitName !== null ? { id: r.mainUnitId, name: r.mainUnitName } : null,
      infoUnit: r.infoUnitId !== null && r.infoUnitName !== null ? { id: r.infoUnitId, name: r.infoUnitName } : null,
      uploadedBy: r.uploadedBy,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
    total: n,
    page: f.page,
    pageSize: f.pageSize,
  };
}
