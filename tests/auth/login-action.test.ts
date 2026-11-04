import { beforeEach, describe, expect, it, vi } from "vitest";

const signInMock = vi.fn();
// next-auth importa next/server không phân giải được dưới vitest; chỉ cần lớp AuthError.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/auth/config", () => ({ signIn: (...a: unknown[]) => signInMock(...a) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "7.7.7.7" }) }));

import { AuthError } from "next-auth";
import { loginAction } from "@/app/login/actions";
import { resetLoginRateLimit } from "@/auth/rate-limit";

const form = (u: string, p: string) => {
  const f = new FormData();
  f.set("username", u);
  f.set("password", p);
  return f;
};

describe("loginAction", () => {
  beforeEach(() => {
    resetLoginRateLimit();
    signInMock.mockReset();
  });

  it("sai mật khẩu -> trạng thái lỗi invalid", async () => {
    signInMock.mockRejectedValue(new AuthError("CredentialsSignin"));
    expect(await loginAction({}, form("ad", "wrong"))).toEqual({ error: "invalid" });
  });

  it("lần thứ 6 trong 1 phút bị chặn, signIn không được gọi", async () => {
    signInMock.mockRejectedValue(new AuthError("CredentialsSignin"));
    for (let i = 0; i < 5; i++) expect((await loginAction({}, form("ad", "x"))).error).toBe("invalid");
    expect(await loginAction({}, form("ad", "right"))).toEqual({ error: "rate_limited" });
    expect(signInMock).toHaveBeenCalledTimes(5);
  });

  it("lỗi không phải AuthError (redirect khi thành công) được ném lại", async () => {
    signInMock.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(loginAction({}, form("ad", "right"))).rejects.toThrow("NEXT_REDIRECT");
  });
});
