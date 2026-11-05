import { toErrorResponse } from "@/auth/guards";
import { SettingsError, type SettingsErrorCode } from "./settings";

const STATUS: Record<SettingsErrorCode, number> = {
  invalid_base_url: 400,
  invalid_var: 400,
  invalid_timeout: 400,
  invalid_retries: 400,
  invalid_api_key: 400,
  api_key_required: 400,
  api_key_unreadable: 400,
};

export function settingsErrorResponse(e: unknown): Response {
  if (e instanceof SettingsError) return Response.json({ error: e.message, code: e.code }, { status: STATUS[e.code] });
  return toErrorResponse(e);
}

export const notFoundKey = () => Response.json({ error: "Không tìm thấy tích hợp" }, { status: 404 });
