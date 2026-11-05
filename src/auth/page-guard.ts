import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import { HttpError, requireAdmin, requireUser } from "./guards";

/** Dùng trong layout/page của vùng người dùng: chưa đăng nhập hoặc tài khoản bị khóa -> /login. */
export async function requireUserPage(): Promise<Session> {
  try {
    return await requireUser();
  } catch (e) {
    if (e instanceof HttpError) redirect("/login");
    throw e;
  }
}

/**
 * Bắt buộc gọi ĐẦU TIÊN trong mọi page /admin (trước mọi truy vấn dữ liệu): layout không chạy lại khi điều hướng
 * phía client và một yêu cầu RSC tự chế có thể lấy payload của page mà không render layout.
 * 401 (chưa đăng nhập/bị khóa) -> /login; 403 (không phải admin) -> /.
 */
export async function requireAdminPage(): Promise<Session> {
  try {
    return await requireAdmin();
  } catch (e) {
    if (e instanceof HttpError) redirect(e.status === 401 ? "/login" : "/");
    throw e;
  }
}
