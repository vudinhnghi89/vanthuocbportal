import { requireAdmin } from "@/auth/guards";
import { getDifySettingsView } from "@/server/settings";
import { settingsErrorResponse } from "@/server/settings-http";

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
    const [ocr, agent] = await Promise.all([getDifySettingsView("dify_ocr"), getDifySettingsView("dify_agent")]);
    return Response.json({ dify_ocr: ocr, dify_agent: agent });
  } catch (e) {
    return settingsErrorResponse(e);
  }
}
