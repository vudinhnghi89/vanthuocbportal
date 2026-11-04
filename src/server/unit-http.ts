import { toErrorResponse } from "@/auth/guards";
import { UnitError, type UnitErrorCode } from "./units";

const STATUS: Record<UnitErrorCode, number> = {
  invalid_name: 400,
  duplicate_name: 409,
  not_found: 404,
  secretariat_protected: 409,
};

/** HttpError/UnitError -> JSON Response; lỗi khác ném lại. */
export function unitErrorResponse(e: unknown): Response {
  if (e instanceof UnitError) return Response.json({ error: e.message, code: e.code }, { status: STATUS[e.code] });
  return toErrorResponse(e);
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
