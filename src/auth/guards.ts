import type { Session } from "next-auth";
import { auth } from "./config";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Dùng trong route handler: HttpError -> JSON Response, lỗi khác ném lại. */
export function toErrorResponse(e: unknown): Response {
  if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
  throw e;
}

export async function requireUser(): Promise<Session> {
  const session = await auth();
  // Tài khoản bị khóa: phiên không còn hợp lệ -> 401 (403 chỉ dành cho thiếu vai trò).
  if (!session?.user?.active) throw new HttpError(401, "Chưa đăng nhập");
  return session;
}

export async function requireAdmin(): Promise<Session> {
  const session = await requireUser();
  if (session.user.role !== "admin") throw new HttpError(403, "Không đủ quyền");
  return session;
}
