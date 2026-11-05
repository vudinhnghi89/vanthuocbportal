import { requireUser, toErrorResponse } from "@/auth/guards";
import { ClassifyError, classifyDocument } from "@/server/document-detail";

const fail = (status: number, error: string) => Response.json({ error }, { status });

/** Phân loại thủ công văn bản không khớp rule. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const session = await requireUser();
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail(400, "Dữ liệu gửi lên không hợp lệ");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "Dữ liệu gửi lên không hợp lệ");
    try {
      const out = await classifyDocument(id, body as { mainUnitId?: unknown; infoUnitId?: unknown }, session.user.id);
      return Response.json(out);
    } catch (e) {
      if (e instanceof ClassifyError) return fail(e.status, e.message);
      throw e;
    }
  } catch (e) {
    return toErrorResponse(e);
  }
}
