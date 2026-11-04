import { NextResponse } from "next/server";
import { auth } from "@/auth/config";

// Chuyển trang chưa đăng nhập về /login. API trả 401 JSON (guards ở từng route).
export default auth((req) => {
  if (req.auth?.user?.active) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", req.nextUrl));
});

export const config = {
  matcher: ["/((?!login|api/auth|api/health|_next/static|_next/image|favicon.ico).*)"],
};
