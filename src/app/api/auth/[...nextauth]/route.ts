import type { NextRequest } from "next/server";
import { handlers } from "@/auth/config";
import { getClientIp } from "@/auth/client-ip";
import { checkLoginRateLimit } from "@/auth/rate-limit";

export const dynamic = "force-dynamic";

export const GET = handlers.GET;

export async function POST(req: NextRequest) {
  if (new URL(req.url).pathname.endsWith("/callback/credentials")) {
    const ip = getClientIp(req.headers);
    if (!checkLoginRateLimit(ip)) {
      return Response.json({ error: "Thử đăng nhập quá nhiều lần, vui lòng đợi 1 phút" }, { status: 429 });
    }
  }
  return handlers.POST(req);
}
