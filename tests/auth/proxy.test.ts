import { describe, expect, it, vi } from "vitest";
vi.mock("@/auth/config", () => ({ auth: (f: unknown) => f }));
import { config } from "@/proxy";
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
  it("API retry chưa đăng nhập -> 401", () =>
    expect(proxyDecision("/api/documents/00000000-0000-4000-8000-000000000000/retry", false)).toBe("unauthorized"));
  it("đã đăng nhập -> đi tiếp", () => expect(proxyDecision("/documents", true)).toBe("next"));
  it("đường dẫn công khai đi tiếp", () => expect(proxyDecision("/login", false)).toBe("next"));
  it("/login-evil chưa đăng nhập -> redirect", () => expect(proxyDecision("/login-evil", false)).toBe("redirect"));
});

describe("proxy matcher", () => {
  const re = new RegExp(`^${config.matcher[0]}$`);
  it("/api/documents (upload) bị loại để body không bị cắt 10 MiB", () => {
    expect(re.test("/api/documents")).toBe(false);
  });
  it.each(["/api/documents/123/retry", "/api/documentsX", "/api/documents-x", "/api/admin/units", "/documents"])(
    "%s vẫn qua proxy",
    (p) => expect(re.test(p)).toBe(true),
  );
});
