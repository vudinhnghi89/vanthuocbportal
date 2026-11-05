type Env = { NODE_ENV?: string; AUTH_URL?: string };

/**
 * Cookie phiên chỉ gắn Secure (và tiền tố __Secure-) ở production. Nếu AUTH_URL được đặt là địa chỉ http://
 * (triển khai HTTP thuần phía sau Caddy `:80`) thì tắt Secure, vì trình duyệt sẽ bỏ cookie Secure trên HTTP.
 * Không đặt AUTH_URL = giữ mặc định an toàn (Secure khi production).
 */
export function secureCookiesEnabled(env: Env = process.env): boolean {
  if (env.NODE_ENV !== "production") return false;
  const url = env.AUTH_URL?.trim();
  return !(url && /^http:\/\//i.test(url));
}

/** Cờ cookie phiên: HttpOnly + SameSite=Lax + Path=/ ; Secure theo secureCookiesEnabled. */
export function sessionCookieOptions(env: Env = process.env) {
  return { httpOnly: true, sameSite: "lax" as const, path: "/", secure: secureCookiesEnabled(env) };
}
