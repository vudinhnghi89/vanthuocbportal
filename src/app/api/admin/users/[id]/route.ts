import { requireAdmin } from "@/auth/guards";
import { listUsers, resetPassword, setActive } from "@/server/users";
import { readJson } from "@/server/unit-http";
import { userErrorResponse } from "@/server/user-http";

const INT4_MAX = 2147483647;

/** Một request: { active } để bật/tắt, hoặc { password } để đặt lại mật khẩu. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireAdmin();
    const { id: rawId } = await ctx.params;
    const id = /^\d{1,10}$/.test(rawId) ? Number(rawId) : NaN;
    if (!Number.isSafeInteger(id) || id < 1 || id > INT4_MAX) {
      return Response.json({ error: "id không hợp lệ" }, { status: 400 });
    }
    const body = await readJson(req);
    const hasActive = !!body && "active" in body;
    const hasPassword = !!body && "password" in body;
    if (hasActive === hasPassword) {
      return Response.json({ error: "Cần đúng một trong active hoặc password" }, { status: 400 });
    }
    if (hasActive) {
      if (typeof body.active !== "boolean") return Response.json({ error: "active không hợp lệ" }, { status: 400 });
      return Response.json(await setActive(id, body.active));
    }
    if (typeof body!.password !== "string") return Response.json({ error: "password không hợp lệ" }, { status: 400 });
    await resetPassword(id, body!.password);
    const user = (await listUsers()).find((u) => u.id === id);
    return Response.json(user);
  } catch (e) {
    return userErrorResponse(e);
  }
}
