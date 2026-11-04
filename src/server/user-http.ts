import { toErrorResponse } from "@/auth/guards";
import { UserError, type UserErrorCode } from "./users";

const STATUS: Record<UserErrorCode, number> = {
  invalid_username: 400,
  invalid_password: 400,
  invalid_role: 400,
  duplicate_username: 409,
  not_found: 404,
  last_admin: 409,
};

/** HttpError/UserError -> JSON Response; lỗi khác ném lại. */
export function userErrorResponse(e: unknown): Response {
  if (e instanceof UserError) return Response.json({ error: e.message, code: e.code }, { status: STATUS[e.code] });
  return toErrorResponse(e);
}
