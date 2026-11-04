import type { NextRequest } from "next/server";
import { handlers } from "@/auth/config";
import { checkLoginRateLimit } from "@/auth/rate-limit";

export const dynamic = "force-dynamic";

export const GET = handlers.GET;

export async function POST(req: NextRequest) {
  if (new URL(req.url).pathname.endsWith("/callback/credentials")) {
    // Caddy đặt X-Forwarded-For; lấy phần tử cuối do proxy tin cậy thêm vào.
    const ip = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
    if (!checkLoginRateLimit(ip)) {
      return Response.json({ error: "Thử đăng nhập quá nhiều lần, vui lòng đợi 1 phút" }, { status: 429 });
    }
  }
  return handlers.POST(req);
}
