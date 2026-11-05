import { test, expect, upload, statusOf } from "./fixtures";
import { UNITS } from "./support/env";

test("1. Upload → khớp rule → hoàn tất phân loại → đơn vị xử lý → xong", async ({ as }) => {
  const page = await as("vanthu");
  const row = await upload(page, "ketoan-1.pdf");

  // Toast thời gian thực nằm trong vùng aria-live và nêu cả hai đơn vị.
  const toasts = page.getByRole("region", { name: "Thông báo mới" });
  await expect(toasts).toHaveAttribute("aria-live", "polite");
  await expect(toasts).toContainText(`Đơn vị xử lý chính: ${UNITS.finance}; Đơn vị nhận thông tin: ${UNITS.admin}`);

  await expect(statusOf(row)).toHaveText("Hoàn tất phân loại");
  await expect(row.getByRole("cell", { name: UNITS.finance, exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: UNITS.admin, exact: true })).toBeVisible();
  await expect(row.locator(".badge--manual")).toHaveCount(0);

  await row.getByRole("button", { name: "Chuyển đơn vị xử lý" }).click();
  await expect(statusOf(row)).toHaveText("Đơn vị đang xử lý");
  await row.getByRole("button", { name: "Hoàn tất" }).click();
  await expect(statusOf(row)).toHaveText("Xong");

  await row.getByRole("link", { name: "ketoan-1.pdf" }).click();
  await expect(page.getByRole("heading", { name: "ketoan-1.pdf" })).toBeVisible();
  await page.getByRole("tab", { name: "Lịch sử trạng thái" }).click();
  const history = page.getByRole("tabpanel", { name: "Lịch sử trạng thái" }).getByRole("row");
  const transitions: [string, string][] = [
    ["Hàng đợi", "Đang xử lý OCR"],
    ["Đang xử lý OCR", "Đang tra soát rule"],
    ["Đang tra soát rule", "Hoàn tất phân loại"],
    ["Hoàn tất phân loại", "Đơn vị đang xử lý"],
    ["Đơn vị đang xử lý", "Xong"],
  ];
  for (const [from, to] of transitions) {
    await expect(history.filter({ has: page.getByRole("cell", { name: from, exact: true }) }).filter({ has: page.getByRole("cell", { name: to, exact: true }) })).toHaveCount(1);
  }
  await expect(history.filter({ hasText: "Khớp rule" })).toHaveCount(1);
});

test("4. Nhiều rule khớp → agent chọn", async ({ as }) => {
  const page = await as("vanthu");
  const row = await upload(page, "multi-dutoan.pdf");
  await expect(statusOf(row)).toHaveText("Hoàn tất phân loại");
  // R3 "Thông báo dự toán": chính Phòng Tài chính, nhận tin Phòng Kế hoạch (R4 sẽ là Phòng Hành chính).
  await expect(row.getByRole("cell", { name: UNITS.finance, exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: UNITS.planning, exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: UNITS.admin, exact: true })).toHaveCount(0);
  await expect(row.locator(".badge--manual")).toHaveCount(0);

  await row.getByRole("link", { name: "multi-dutoan.pdf" }).click();
  await expect(page.getByText("AI chọn rule")).toBeVisible();
});

test("6. Lỗi OCR → hiện lỗi → Chạy lại → hoàn tất phân loại", async ({ as, request }) => {
  const page = await as("vanthu");
  const mock = process.env.E2E_MOCK_PORT!;
  // Mock từ chối loi-1.pdf bằng HTTP 400 (lỗi vĩnh viễn: worker đánh dấu failed ngay, không chờ backoff 30s của pg-boss).
  const set = (fail: string[]) => request.post(`http://127.0.0.1:${mock}/__control`, { data: { fail } });
  expect((await set(["loi-1.pdf"])).ok()).toBe(true);
  try {
    const row = await upload(page, "loi-1.pdf");
    await expect(statusOf(row)).toHaveText("Lỗi");
    await expect(row.locator(".doc-error-text")).toContainText("Dify từ chối yêu cầu (HTTP 400)");

    expect((await set([])).ok()).toBe(true);
    await row.getByRole("button", { name: "Chạy lại" }).click();
    await expect(page.getByText("Đã đưa văn bản vào hàng đợi chạy lại")).toBeVisible();
    await expect(statusOf(row)).toHaveText("Hoàn tất phân loại");
    await expect(row.getByRole("cell", { name: UNITS.finance, exact: true })).toBeVisible();
  } finally {
    await set(["loi-1.pdf"]);
  }
});
