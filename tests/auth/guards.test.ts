import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/auth/config", () => ({ auth: () => authMock() }));

import { HttpError, requireAdmin, requireUser, toErrorResponse } from "@/auth/guards";

const session = (role: "admin" | "user", extra: Record<string, unknown> = {}) => ({
  user: { id: 1, username: "u", role, active: true, ...extra },
  expires: "2099-01-01",
});

async function status(p: Promise<unknown>) {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
}

describe("guards", () => {
  beforeEach(() => authMock.mockReset());

  it("không có session -> 401", async () => {
    authMock.mockResolvedValue(null);
    expect(await status(requireUser())).toBe(401);
    expect(await status(requireAdmin())).toBe(401);
  });

  it("user thường gọi requireAdmin -> 403, requireUser -> ok", async () => {
    authMock.mockResolvedValue(session("user"));
    expect(await status(requireAdmin())).toBe(403);
    expect(await status(requireUser())).toBe(200);
  });

  it("admin -> ok và session có id, username, role", async () => {
    authMock.mockResolvedValue(session("admin"));
    const s = await requireAdmin();
    expect(s.user).toMatchObject({ id: 1, username: "u", role: "admin" });
  });

  it("tài khoản bị khóa -> 401", async () => {
    authMock.mockResolvedValue(session("admin", { active: false }));
    expect(await status(requireUser())).toBe(401);
    expect(await status(requireAdmin())).toBe(401);
  });
});

describe("mẫu admin API: wrapper route handler", () => {
  beforeEach(() => authMock.mockReset());

  // Handler chỉ dùng cho test, không phải route production.
  async function handler(): Promise<Response> {
    try {
      await requireAdmin();
      return Response.json({ ok: true });
    } catch (e) {
      return toErrorResponse(e);
    }
  }

  it("chưa đăng nhập 401, user 403, admin 200", async () => {
    authMock.mockResolvedValue(null);
    expect((await handler()).status).toBe(401);
    authMock.mockResolvedValue(session("user"));
    expect((await handler()).status).toBe(403);
    authMock.mockResolvedValue(session("admin"));
    const r = await handler();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("lỗi không phải HttpError được ném lại", () => {
    expect(() => toErrorResponse(new Error("boom"))).toThrow("boom");
  });
});
