import { requireAdmin } from "@/auth/guards";
import { createUser, listUsers } from "@/server/users";
import { readJson } from "@/server/unit-http";
import { userErrorResponse } from "@/server/user-http";

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
    return Response.json(await listUsers());
  } catch (e) {
    return userErrorResponse(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireAdmin();
    const body = await readJson(req);
    if (typeof body?.username !== "string" || typeof body.password !== "string" || typeof body.role !== "string") {
      return Response.json({ error: "Thiếu tên đăng nhập, mật khẩu hoặc vai trò" }, { status: 400 });
    }
    return Response.json(await createUser(body.username, body.password, body.role as "admin" | "user"), {
      status: 201,
    });
  } catch (e) {
    return userErrorResponse(e);
  }
}
