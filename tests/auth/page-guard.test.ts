import { beforeEach, describe, expect, it, vi } from "vitest";

// Hàm thường (không phải vi.fn) để promise bị từ chối không bị vitest ghi nhận như lỗi chưa xử lý.
let authImpl: () => Promise<unknown> = async () => null;
const authMock = {
  reset: () => {
    authImpl = async () => null;
  },
  resolve: (v: unknown) => {
    authImpl = async () => v;
  },
  reject: (e: unknown) => {
    authImpl = async () => {
      throw e;
    };
  },
};
vi.mock("@/auth/config", () => ({ auth: () => authImpl() }));
class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));

import { requireAdminPage, requireUserPage } from "@/auth/page-guard";

const session = (role: "admin" | "user", active = true) => ({
  user: { id: 1, username: "u", role, active },
  expires: "2099-01-01",
});

async function target(p: Promise<unknown>): Promise<string | "ok"> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof Redirect) return e.to;
    throw e;
  }
}

describe("requireAdminPage", () => {
  beforeEach(() => authMock.reset());

  it("chưa đăng nhập -> /login", async () => {
    authMock.resolve(null);
    expect(await target(requireAdminPage())).toBe("/login");
  });
  it("tài khoản bị khóa -> /login", async () => {
    authMock.resolve(session("admin", false));
    expect(await target(requireAdminPage())).toBe("/login");
  });
  it("user thường -> /", async () => {
    authMock.resolve(session("user"));
    expect(await target(requireAdminPage())).toBe("/");
  });
  it("admin đang hoạt động -> qua, trả về session", async () => {
    authMock.resolve(session("admin"));
    const s = await requireAdminPage();
    expect(s.user.role).toBe("admin");
  });
  it("lỗi khác được ném lại", async () => {
    authMock.reject(new Error("db down"));
    const err = await requireAdminPage().then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe("db down");
  });
});

describe("requireUserPage", () => {
  beforeEach(() => authMock.reset());
  it("chưa đăng nhập -> /login, user thường qua", async () => {
    authMock.resolve(null);
    expect(await target(requireUserPage())).toBe("/login");
    authMock.resolve(session("user"));
    expect(await target(requireUserPage())).toBe("ok");
  });
});
