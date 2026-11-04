import { describe, expect, it } from "vitest";
import { isPublicPath, proxyDecision } from "@/auth/public-paths";

describe("isPublicPath", () => {
  it.each(["/login", "/api/auth/session", "/api/auth/callback/credentials", "/api/health", "/api/auth"])(
    "%s công khai",
    (p) => expect(isPublicPath(p)).toBe(true),
  );
  it.each([
    "/", "/login-evil", "/loginX", "/api/healthz", "/api/health-admin", "/api/authz",
    "/%6Cogin-evil", "/%6Cogin", "/api/health%2F..%2Fx", "/api/auth%2F..%2Fx", "/documents",
  ])("%s không công khai", (p) => expect(isPublicPath(p)).toBe(false));
});

describe("proxyDecision", () => {
  it("trang chưa đăng nhập -> redirect", () => expect(proxyDecision("/documents", false)).toBe("redirect"));
  it("API chưa đăng nhập -> 401", () => expect(proxyDecision("/api/documents", false)).toBe("unauthorized"));
  it("đã đăng nhập -> đi tiếp", () => expect(proxyDecision("/documents", true)).toBe("next"));
  it("đường dẫn công khai đi tiếp", () => expect(proxyDecision("/login", false)).toBe("next"));
  it("/login-evil chưa đăng nhập -> redirect", () => expect(proxyDecision("/login-evil", false)).toBe("redirect"));
});
