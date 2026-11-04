import { requireAdmin } from "@/auth/guards";
import { createUnit, listUnits } from "@/server/units";
import { readJson, unitErrorResponse } from "@/server/unit-http";

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
    return Response.json(await listUnits());
  } catch (e) {
    return unitErrorResponse(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireAdmin();
    const body = await readJson(req);
    if (typeof body?.name !== "string") return Response.json({ error: "Thiếu tên đơn vị" }, { status: 400 });
    return Response.json(await createUnit(body.name), { status: 201 });
  } catch (e) {
    return unitErrorResponse(e);
  }
}
