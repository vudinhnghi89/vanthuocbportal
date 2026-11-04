import { requireAdmin } from "@/auth/guards";
import { getDifySettingsView, isIntegrationKey, saveDifySettings, type DifySettingsInput } from "@/server/settings";
import { notFoundKey, settingsErrorResponse } from "@/server/settings-http";
import { readJson } from "@/server/unit-http";

type Ctx = { params: Promise<{ key: string }> };

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const admin = await requireAdmin();
    const { key } = await ctx.params;
    if (!isIntegrationKey(key)) return notFoundKey();
    const body = await readJson(req);
    if (!body) return Response.json({ error: "Dữ liệu không hợp lệ" }, { status: 400 });
    await saveDifySettings(
      key,
      {
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        inputVar: body.inputVar,
        outputVarMd: body.outputVarMd,
        outputVarJson: body.outputVarJson,
        timeoutS: body.timeoutS,
        retries: body.retries,
      } as DifySettingsInput,
      admin.user.id,
    );
    return Response.json(await getDifySettingsView(key));
  } catch (e) {
    return settingsErrorResponse(e);
  }
}
