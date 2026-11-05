import { test, expect, upload, statusOf } from "./fixtures";
import { UNITS } from "./support/env";

test.describe.configure({ mode: "serial" });

test("2. Admin sửa rule → lịch sử chỉnh sửa; tắt rule → Ban thư ký", async ({ as }) => {
  const admin = await as("admin");
  await admin.goto("/admin/rules");
  const r1 = admin.getByRole("row").filter({ hasText: "Công văn tài chính" });
  await r1.getByRole("button", { name: "Sửa", exact: true }).click();
  await expect(admin.getByRole("heading", { name: /^Sửa quy tắc #\d+$/ })).toBeVisible();
  await admin.getByLabel("Tiêu đề").fill("Công văn tài chính (đã sửa)");
  await admin.getByLabel("Độ ưu tiên").fill("5");
  await admin.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(admin.getByRole("row").filter({ hasText: "Công văn tài chính (đã sửa)" })).toContainText("5");

  await admin.goto("/admin/rules/history");
  const entry = admin.getByRole("row").filter({ hasText: "Công văn tài chính (đã sửa)" }).filter({ hasText: "Sửa" });
  await expect(entry.getByRole("cell", { name: "admin", exact: true })).toBeVisible();
  await expect(entry.getByText("Tiêu đề: Công văn tài chính → Công văn tài chính (đã sửa)")).toBeVisible();
  await expect(entry.getByText("Độ ưu tiên: 1 → 5")).toBeVisible();

  // Tắt R2 → văn bản của Bộ Y tế không còn khớp → Ban thư ký, cần phân loại thủ công.
  await admin.goto("/admin/rules");
  const r2 = admin.getByRole("row").filter({ hasText: "Thông báo y tế" });
  try {
    await r2.getByRole("button", { name: "Tắt", exact: true }).click();
    await expect(r2).toContainText("Đã tắt");

    const user = await as("vanthu");
    const row = await upload(user, "ycb-1.pdf");
    await expect(statusOf(row)).toHaveText("Hoàn tất phân loại");
    await expect(row.getByRole("cell", { name: UNITS.secretariat, exact: true })).toBeVisible();
    await expect(row.locator(".badge--manual")).toHaveText("Cần phân loại thủ công");
  } finally {
    await admin.goto("/admin/rules");
    const again = admin.getByRole("row").filter({ hasText: "Thông báo y tế" });
    if (await again.getByRole("button", { name: "Bật", exact: true }).count()) {
      await again.getByRole("button", { name: "Bật", exact: true }).click();
      await expect(again).toContainText("Đang bật");
    }
  }
});

test("3. Không khớp → Ban thư ký → phân loại thủ công → tạo rule → upload lại tự khớp", async ({ as }) => {
  const user = await as("vanthu");
  const row = await upload(user, "unknown-1.pdf");
  await expect(statusOf(row)).toHaveText("Hoàn tất phân loại");
  await expect(row.getByRole("cell", { name: UNITS.secretariat, exact: true })).toBeVisible();
  await expect(row.locator(".badge--manual")).toHaveText("Cần phân loại thủ công");

  await row.getByRole("link", { name: "unknown-1.pdf" }).click();
  await expect(user.getByRole("heading", { name: "unknown-1.pdf" })).toBeVisible();
  const docUrl = user.url();
  const form = user.getByRole("form", { name: "Phân loại thủ công" });
  await form.getByLabel("Đơn vị xử lý chính").selectOption({ label: UNITS.planning });
  await form.getByLabel("Đơn vị nhận thông tin").selectOption({ label: UNITS.admin });
  await form.getByRole("button", { name: "Xác nhận phân loại" }).click();
  await expect(user.getByText("Đã lưu phân loại thủ công")).toBeVisible();
  await expect(user.getByRole("region", { name: "Thông báo mới" })).toContainText(
    `đã được Ban thư ký phân loại — Đơn vị xử lý chính: ${UNITS.planning}; Đơn vị nhận thông tin: ${UNITS.admin}`,
  );

  const admin = await as("admin");
  await admin.goto(docUrl);
  await admin.getByRole("link", { name: "Tạo rule từ văn bản này" }).click();
  await expect(admin.getByLabel("Cơ quan ban hành")).toHaveValue("Cục Lạ");
  await expect(admin.getByLabel("Loại văn bản")).toHaveValue("Quyết định");
  await expect(admin.getByLabel("Đơn vị chủ trì").locator("option:checked")).toHaveText(UNITS.planning);
  await expect(admin.getByLabel("Đơn vị nhận để biết").locator("option:checked")).toHaveText(UNITS.admin);
  await admin.getByRole("button", { name: "Thêm quy tắc", exact: true }).click();
  await expect(admin.getByText("Đã lưu quy tắc mới.")).toBeVisible();

  const again = await upload(user, "unknown-2.pdf");
  await expect(statusOf(again)).toHaveText("Hoàn tất phân loại");
  await expect(again.getByRole("cell", { name: UNITS.planning, exact: true })).toBeVisible();
  await expect(again.getByRole("cell", { name: UNITS.admin, exact: true })).toBeVisible();
  await expect(again.locator(".badge--manual")).toHaveCount(0);
});
