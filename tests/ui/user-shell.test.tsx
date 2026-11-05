// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const authMock = vi.fn();
vi.mock("@/auth/config", () => ({ auth: () => authMock() }));
const redirectMock = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT:${to}`);
});
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirectMock(to) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { requireUserPage } from "@/auth/page-guard";
import { UserHeader } from "@/components/UserHeader";

const session = (role: "admin" | "user", active = true) => ({
  user: { id: 1, username: "lan", role, active },
  expires: "2099-01-01",
});

describe("requireUserPage", () => {
  beforeEach(() => {
    authMock.mockReset();
    redirectMock.mockClear();
  });
  it("redirects to /login when unauthenticated", async () => {
    authMock.mockResolvedValue(null);
    await expect(requireUserPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });
  it("redirects to /login when the account is inactive", async () => {
    authMock.mockResolvedValue(session("user", false));
    await expect(requireUserPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });
  it("returns the session for an active user", async () => {
    authMock.mockResolvedValue(session("user"));
    expect((await requireUserPage()).user.username).toBe("lan");
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("UserHeader", () => {
  afterEach(cleanup);
  const noop = async () => {};
  it("shows app name, username, logout; admin sees 'Quản trị'", () => {
    render(<UserHeader username="lan" role="admin" signOutAction={noop} />);
    expect(screen.getByText("Văn thư")).toBeTruthy();
    expect(screen.getByText("lan")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Đăng xuất" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Quản trị" }).getAttribute("href")).toBe("/admin/units");
  });
  it("hides 'Quản trị' for a normal user", () => {
    render(<UserHeader username="lan" role="user" signOutAction={noop} />);
    expect(screen.queryByRole("link", { name: "Quản trị" })).toBeNull();
  });
});
