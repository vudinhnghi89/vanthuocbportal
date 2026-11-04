import { toErrorResponse } from "@/auth/guards";
import { AliasError, type AliasErrorCode } from "./aliases";

const STATUS: Record<AliasErrorCode, number> = {
  invalid_alias: 400,
  invalid_canonical: 400,
  too_long: 400,
  same_as_canonical: 400,
  duplicate_alias: 409,
  alias_chain: 409,
  not_found: 404,
};

/** HttpError/AliasError -> JSON Response; lỗi khác ném lại. */
export function aliasErrorResponse(e: unknown): Response {
  if (e instanceof AliasError) return Response.json({ error: e.message, code: e.code }, { status: STATUS[e.code] });
  return toErrorResponse(e);
}

/** Chỉ chữ số thập phân, <= int4 max; ngược lại null. */
export function parseId(raw: string): number | null {
  if (!/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 2147483647 ? n : null;
}
