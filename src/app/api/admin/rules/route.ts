import { requireAdmin } from "@/auth/guards";
import { createRule, listRules, type RuleInput } from "@/server/rules";
import { ruleErrorResponse } from "@/server/rule-http";
import { readJson } from "@/server/unit-http";

export async function GET(req: Request): Promise<Response> {
  try {
    await requireAdmin();
    const sp = new URL(req.url).searchParams;
    const active = sp.get("active");
    if (active !== null && active !== "true" && active !== "false") {
      return Response.json({ error: "active không hợp lệ" }, { status: 400 });
    }
    return Response.json(
      await listRules({ q: sp.get("q") ?? undefined, active: active === null ? undefined : active === "true" }),
    );
  } catch (e) {
    return ruleErrorResponse(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const admin = await requireAdmin();
    const body = await readJson(req);
    if (!body) return Response.json({ error: "Dữ liệu không hợp lệ" }, { status: 400 });
    const input = { ...body, infoUnitId: body.infoUnitId ?? null } as RuleInput;
    return Response.json(await createRule(input, admin.user.id), { status: 201 });
  } catch (e) {
    return ruleErrorResponse(e);
  }
}
