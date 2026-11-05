import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { sessionCookieOptions, secureCookiesEnabled } from "@/auth/cookie-options";

type Rule = { source: string; headers: { key: string; value: string }[] };
const rules = async () => (await nextConfig.headers!()) as Rule[];
const header = (r: Rule, k: string) => r.headers.find((h) => h.key === k)?.value;

describe("security headers (next.config)", () => {
  it("rule toàn app có nosniff, referrer, XFO, permissions-policy và CSP", async () => {
    const [all] = await rules();
    expect(header(all, "X-Content-Type-Options")).toBe("nosniff");
    expect(header(all, "Referrer-Policy")).toBe("same-origin");
    expect(header(all, "X-Frame-Options")).toBe("DENY");
    expect(header(all, "Permissions-Policy")).toMatch(/camera=\(\).*microphone=\(\).*geolocation=\(\).*payment=\(\)/);
    const csp = header(all, "Content-Security-Policy")!;
    for (const d of [
      "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'self'",
      "form-action 'self'", "frame-ancestors 'none'",
    ]) expect(csp).toContain(d);
  });

  it("không có HSTS trong app (chỉ Caddy khi bật HTTPS)", async () => {
    for (const r of await rules()) expect(header(r, "Strict-Transport-Security")).toBeUndefined();
  });

  it("route PDF bị loại khỏi rule CSP toàn app và không bị ghi đè CSP/nosniff", async () => {
    const [all, pdf] = await rules();
    const m = /^\/:path\((.*)\)$/.exec(all.source)!;
    const re = new RegExp(`^/${m[1]}$`);
    const base = "/api/documents/11111111-1111-4111-8111-111111111111";
    expect(re.test(`${base}/file`)).toBe(false);
    expect(re.test(`${base}`)).toBe(true);
    expect(re.test("/login")).toBe(true);
    expect(re.test("/api/health")).toBe(true);
    expect(pdf.source).toBe("/api/documents/:id/file");
    expect(header(pdf, "Content-Security-Policy")).toBeUndefined();
    expect(header(pdf, "X-Content-Type-Options")).toBeUndefined();
  });
});

describe("session cookie options", () => {
  it("HttpOnly, SameSite=Lax, Path=/", () => {
    expect(sessionCookieOptions({ NODE_ENV: "development" })).toEqual({
      httpOnly: true, sameSite: "lax", path: "/", secure: false,
    });
  });
  it("Secure trong production", () => {
    expect(sessionCookieOptions({ NODE_ENV: "production" }).secure).toBe(true);
    expect(secureCookiesEnabled({ NODE_ENV: "production", AUTH_URL: "https://portal.example.vn" })).toBe(true);
  });
  it("AUTH_URL http:// (triển khai HTTP thuần) tắt Secure; ngoài production luôn tắt", () => {
    expect(secureCookiesEnabled({ NODE_ENV: "production", AUTH_URL: "http://10.0.0.5:8080" })).toBe(false);
    expect(secureCookiesEnabled({ NODE_ENV: "development", AUTH_URL: "https://x" })).toBe(false);
  });
});
