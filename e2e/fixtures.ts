import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { stateFile } from "./support/env";
import { makePdf } from "./support/pdf";

type Role = "admin" | "vanthu";

export const test = base.extend<{
  /** Opens a page logged in as the given role (cookies prepared in global-setup); Playwright traces the context, we add a screenshot per page on failure. */
  as: (role: Role) => Promise<Page>;
}>({
  as: async ({ browser, baseURL }, provide, testInfo) => {
    const contexts: { role: Role; ctx: Awaited<ReturnType<typeof browser.newContext>>; page: Page }[] = [];
    await provide(async (role) => {
      const ctx = await browser.newContext({ baseURL, locale: "vi-VN", storageState: stateFile(role) });
      const page = await ctx.newPage();
      contexts.push({ role, ctx, page });
      return page;
    });
    for (const { role, ctx, page } of contexts) {
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (failed) {
        await page.screenshot({ path: testInfo.outputPath(`${role}.png`), fullPage: true }).catch(() => {});
      }
      await ctx.close();
    }
  },
});
export { expect };

/** Upload through the dropzone's file input and wait for the table row of that file. */
export async function upload(page: Page, filename: string): Promise<Locator> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tải văn bản lên" })).toBeVisible();
  await page.getByLabel("Chọn tệp PDF").setInputFiles({
    name: filename,
    mimeType: "application/pdf",
    buffer: makePdf(filename),
  });
  const row = docRow(page, filename);
  await expect(row).toBeVisible();
  return row;
}

export const docRow = (page: Page, filename: string) =>
  page.getByRole("row").filter({ has: page.getByRole("link", { name: filename, exact: true }) });

/** The status badge text of a table row (first cell after the name). */
export const statusOf = (row: Locator) => row.locator(".badge").first();
