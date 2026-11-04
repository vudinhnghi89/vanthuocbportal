import { toErrorResponse } from "@/auth/guards";
import { RuleError, type RuleErrorCode } from "./rules";

const STATUS: Record<RuleErrorCode, number> = {
  invalid_issuer: 400,
  invalid_doc_type: 400,
  invalid_title: 400,
  invalid_summary: 400,
  invalid_priority: 400,
  invalid_unit: 400,
  not_found: 404,
};

export function ruleErrorResponse(e: unknown): Response {
  if (e instanceof RuleError) return Response.json({ error: e.message, code: e.code }, { status: STATUS[e.code] });
  return toErrorResponse(e);
}

export function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
