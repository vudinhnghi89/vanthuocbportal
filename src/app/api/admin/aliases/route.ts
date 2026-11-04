import { requireAdmin } from "@/auth/guards";
import { createAlias, listAliases } from "@/server/aliases";
import { aliasErrorResponse } from "@/server/alias-http";
import { readJson } from "@/server/unit-http";

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
    return Response.json(await listAliases());
  } catch (e) {
    return aliasErrorResponse(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const admin = await requireAdmin();
    const body = await readJson(req);
    if (typeof body?.alias !== "string" || typeof body?.canonicalIssuer !== "string") {
      return Response.json({ error: "Thiếu bí danh hoặc tên cơ quan chuẩn" }, { status: 400 });
    }
    return Response.json(await createAlias(body.alias, body.canonicalIssuer, admin.user.id), { status: 201 });
  } catch (e) {
    return aliasErrorResponse(e);
  }
}
