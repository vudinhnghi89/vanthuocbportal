import { NextResponse } from "next/server";
import { auth } from "@/auth/config";
import { proxyDecision } from "@/auth/public-paths";

// Chuyển trang chưa đăng nhập về /login. API trả 401 JSON. Đường dẫn công khai quyết định trong proxyDecision.
export default auth((req) => {
  const d = proxyDecision(req.nextUrl.pathname, Boolean(req.auth?.user?.active));
  if (d === "next") return NextResponse.next();
  if (d === "unauthorized") return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", req.nextUrl));
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
