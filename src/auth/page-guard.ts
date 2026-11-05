import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import { HttpError, requireUser } from "./guards";

/** Dùng trong layout/page của vùng người dùng: chưa đăng nhập hoặc tài khoản bị khóa -> /login. */
export async function requireUserPage(): Promise<Session> {
  try {
    return await requireUser();
  } catch (e) {
    if (e instanceof HttpError) redirect("/login");
    throw e;
  }
}
