import { requireAdmin } from "@/auth/guards";
import { deleteAlias } from "@/server/aliases";
import { aliasErrorResponse, parseId } from "@/server/alias-http";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireAdmin();
    const { id: rawId } = await ctx.params;
    const id = parseId(rawId);
    if (id === null) return Response.json({ error: "id không hợp lệ" }, { status: 400 });
    await deleteAlias(id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return aliasErrorResponse(e);
  }
}
