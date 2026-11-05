import { requireUser, toErrorResponse } from "@/auth/guards";
import { UUID_RE, getDocumentDetail } from "@/server/document-detail";

/** Chi tiết một văn bản (không có đường dẫn tệp). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireUser();
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return Response.json({ error: "id không hợp lệ" }, { status: 400 });
    const detail = await getDocumentDetail(id);
    if (!detail) return Response.json({ error: "Không tìm thấy văn bản" }, { status: 404 });
    return Response.json(detail, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
