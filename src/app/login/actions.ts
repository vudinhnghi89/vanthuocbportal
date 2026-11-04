"use server";

import { headers } from "next/headers";
import { AuthError } from "next-auth";
import { signIn } from "@/auth/config";
import { getClientIp } from "@/auth/client-ip";
import { checkLoginRateLimit } from "@/auth/rate-limit";

export type LoginState = { error?: "invalid" | "rate_limited" };

// signIn gọi Auth() trong tiến trình, không đi qua route handler, nên rate limit phải áp dụng tại đây.
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  if (!checkLoginRateLimit(getClientIp(await headers()))) return { error: "rate_limited" };
  try {
    await signIn("credentials", {
      username: formData.get("username"),
      password: formData.get("password"),
      redirectTo: "/",
    });
  } catch (e) {
    if (e instanceof AuthError) return { error: "invalid" };
    throw e; // NEXT_REDIRECT khi đăng nhập thành công
  }
  return {};
}
