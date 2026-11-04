import { requireAdmin } from "@/auth/guards";
import { deleteRule, updateRule, type RulePatch } from "@/server/rules";
import { parseId, ruleErrorResponse } from "@/server/rule-http";
import { readJson } from "@/server/unit-http";

type Ctx = { params: Promise<{ id: string }> };
const FIELDS = ["issuer", "docType", "title", "summary", "mainUnitId", "infoUnitId", "priority"] as const;

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const admin = await requireAdmin();
    const id = parseId((await ctx.params).id);
    if (id === null) return Response.json({ error: "id không hợp lệ" }, { status: 400 });
    const body = await readJson(req);
    if (!body) return Response.json({ error: "Dữ liệu không hợp lệ" }, { status: 400 });
    const patch: Record<string, unknown> = {};
    for (const f of [...FIELDS, "active"]) if (f in body) patch[f] = body[f];
    if (Object.keys(patch).length === 0) return Response.json({ error: "Không có thay đổi" }, { status: 400 });
    const result = await updateRule(id, patch as RulePatch, admin.user.id);
    return Response.json(result.rule);
  } catch (e) {
    return ruleErrorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  try {
    const admin = await requireAdmin();
    const id = parseId((await ctx.params).id);
    if (id === null) return Response.json({ error: "id không hợp lệ" }, { status: 400 });
    await deleteRule(id, admin.user.id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return ruleErrorResponse(e);
  }
}
