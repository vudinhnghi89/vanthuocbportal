import { requireAdmin } from "@/auth/guards";
import { isIntegrationKey, testConnection } from "@/server/settings";
import { notFoundKey, settingsErrorResponse } from "@/server/settings-http";

type Ctx = { params: Promise<{ key: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  try {
    await requireAdmin();
    const { key } = await ctx.params;
    if (!isIntegrationKey(key)) return notFoundKey();
    return Response.json(await testConnection(key));
  } catch (e) {
    return settingsErrorResponse(e);
  }
}
