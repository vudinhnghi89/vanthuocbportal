import { requireAdmin } from "@/auth/guards";
import { listRuleAudit } from "@/server/rules";
import { parseId, ruleErrorResponse } from "@/server/rule-http";

export async function GET(req: Request): Promise<Response> {
  try {
    await requireAdmin();
    const raw = new URL(req.url).searchParams.get("ruleId");
    let ruleId: number | undefined;
    if (raw !== null) {
      const id = parseId(raw);
      if (id === null) return Response.json({ error: "ruleId không hợp lệ" }, { status: 400 });
      ruleId = id;
    }
    return Response.json(await listRuleAudit(ruleId));
  } catch (e) {
    return ruleErrorResponse(e);
  }
}
