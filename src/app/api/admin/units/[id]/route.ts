import { requireAdmin } from "@/auth/guards";
import { updateUnit, type UnitPatch } from "@/server/units";
import { readJson, unitErrorResponse } from "@/server/unit-http";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireAdmin();
    const { id: rawId } = await ctx.params;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "id không hợp lệ" }, { status: 400 });
    const body = await readJson(req);
    const patch: UnitPatch = {};
    if (body && "name" in body) {
      if (typeof body.name !== "string") return Response.json({ error: "name không hợp lệ" }, { status: 400 });
      patch.name = body.name;
    }
    if (body && "active" in body) {
      if (typeof body.active !== "boolean") return Response.json({ error: "active không hợp lệ" }, { status: 400 });
      patch.active = body.active;
    }
    if (patch.name === undefined && patch.active === undefined) {
      return Response.json({ error: "Không có thay đổi" }, { status: 400 });
    }
    return Response.json(await updateUnit(id, patch));
  } catch (e) {
    return unitErrorResponse(e);
  }
}
