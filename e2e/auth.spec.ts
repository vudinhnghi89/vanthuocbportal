import { test, expect } from "@playwright/test";
import { USER_PASSWORD, USER_USERNAME } from "./support/env";

test("Không đăng nhập bị chặn: / về /login, API 401, sai mật khẩu không tạo phiên", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);

  const api = await request.get("/api/documents");
  expect(api.status()).toBe(401);

  await page.getByLabel("Tên đăng nhập").fill(USER_USERNAME);
  await page.getByLabel("Mật khẩu").fill("sai-mat-khau-123");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveText("Sai tên đăng nhập hoặc mật khẩu");
  await expect(page).toHaveURL(/\/login$/);

  const session = await (await page.request.get("/api/auth/session")).json();
  expect(session).toBeNull();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);

  // Đúng mật khẩu thì vào được trang chính qua giao diện.
  await page.getByLabel("Tên đăng nhập").fill(USER_USERNAME);
  await page.getByLabel("Mật khẩu").fill(USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page.getByRole("heading", { name: "Tải văn bản lên" })).toBeVisible();
});
