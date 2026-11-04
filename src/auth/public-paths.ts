export type ProxyDecision = "next" | "unauthorized" | "redirect";

const PUBLIC = ["/login", "/api/auth", "/api/health"];

/** So khớp theo ranh giới đoạn đường dẫn; không giải mã %-encoding nên biến thể mã hóa không được coi là công khai. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function proxyDecision(pathname: string, authenticated: boolean): ProxyDecision {
  if (isPublicPath(pathname) || authenticated) return "next";
  return pathname.startsWith("/api/") ? "unauthorized" : "redirect";
}
