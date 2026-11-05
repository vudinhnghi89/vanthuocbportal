// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DocumentTable } from "@/components/DocumentTable";

const ID = "11111111-1111-4111-8111-111111111111";
const item = (o: Record<string, unknown> = {}) => ({
  id: ID, filename: "cv-01.pdf", status: "classified", error: null, needsManual: false,
  mainUnit: null, infoUnit: null, updatedAt: "2026-03-01T17:30:00.000Z", ...o,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const list = (items: unknown[]) => json({ items, total: items.length, page: 1, pageSize: 20 });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const fetchMock = vi.fn((url: string, init?: RequestInit) => handler(String(url), init));
const docCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/documents?")).length;
const patches = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "PATCH");

const withRow = (row: Record<string, unknown>, patch?: Handler): Handler => (u, init) => {
  if (u.startsWith("/api/units")) return json([]);
  if (init?.method === "PATCH" && patch) return patch(u, init);
  return list([item(row)]);
};

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("manual status actions", () => {
  it.each([
    ["classified", false, "Chuyển đơn vị xử lý"],
    ["unit_processing", false, "Hoàn tất"],
  ])("%s (needsManual=%s) shows %s", async (status, needsManual, label) => {
    handler = withRow({ status, needsManual });
    render(<DocumentTable />);
    const row = (await screen.findByText("cv-01.pdf")).closest("tr")!;
    expect(within(row).getByRole("button", { name: label })).toBeTruthy();
  });

  it("classified + needsManual shows a classify link to the detail page, no buttons", async () => {
    handler = withRow({ status: "classified", needsManual: true });
    render(<DocumentTable />);
    const row = (await screen.findByText("cv-01.pdf")).closest("tr")!;
    expect(within(row).getByRole("link", { name: "Phân loại" }).getAttribute("href")).toBe(`/documents/${ID}`);
    expect(within(row).getByRole("link", { name: "cv-01.pdf" }).getAttribute("href")).toBe(`/documents/${ID}`);
    expect(within(row).queryByRole("button", { name: "Chuyển đơn vị xử lý" })).toBeNull();
  });

  it.each(["queued", "ocr_processing", "rule_checking", "done"])("%s has no action", async (status) => {
    handler = withRow({ status });
    render(<DocumentTable />);
    const row = (await screen.findByText("cv-01.pdf")).closest("tr")!;
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("click sends PATCH with to+from, refetches, shows notice; double click sends once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    handler = withRow({ status: "classified" }, async () => {
      await gate;
      return json({ id: ID, status: "unit_processing", changed: true });
    });
    render(<DocumentTable />);
    const btn = await screen.findByRole("button", { name: "Chuyển đơn vị xử lý" });
    const n = docCalls();
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    release();
    expect(await screen.findByText("Đã cập nhật")).toBeTruthy();
    expect(patches()).toHaveLength(1);
    const [url, init] = patches()[0];
    expect(url).toBe(`/api/documents/${ID}/status`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ to: "unit_processing", from: "classified" });
    await waitFor(() => expect(docCalls()).toBe(n + 1));
  });

  it("unit_processing -> done body", async () => {
    handler = withRow({ status: "unit_processing" }, () => json({ id: ID, status: "done", changed: true }));
    render(<DocumentTable />);
    fireEvent.click(await screen.findByRole("button", { name: "Hoàn tất" }));
    await screen.findByText("Đã cập nhật");
    expect(JSON.parse((patches()[0][1] as RequestInit).body as string)).toEqual({ to: "done", from: "unit_processing" });
  });

  it("409 shows the server message and refetches", async () => {
    handler = withRow({ status: "classified" }, () => json({ error: "Trạng thái đã thay đổi, vui lòng tải lại" }, 409));
    render(<DocumentTable />);
    const btn = await screen.findByRole("button", { name: "Chuyển đơn vị xử lý" });
    const n = docCalls();
    fireEvent.click(btn);
    expect(await screen.findByText("Trạng thái đã thay đổi, vui lòng tải lại")).toBeTruthy();
    await waitFor(() => expect(docCalls()).toBe(n + 1));
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  });

  it("network error shows generic message", async () => {
    handler = withRow({ status: "classified" }, () => {
      throw new TypeError("fail");
    });
    render(<DocumentTable />);
    fireEvent.click(await screen.findByRole("button", { name: "Chuyển đơn vị xử lý" }));
    expect(await screen.findByText("Không thể kết nối máy chủ, vui lòng thử lại")).toBeTruthy();
  });

  it("notice auto-clears after ~6s", async () => {
    vi.useFakeTimers();
    handler = withRow({ status: "classified" }, () => json({ id: ID, status: "unit_processing", changed: true }));
    render(<DocumentTable />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "Chuyển đơn vị xử lý" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText("Đã cập nhật")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_900);
    });
    expect(screen.queryByText("Đã cập nhật")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.queryByText("Đã cập nhật")).toBeNull();
  });

  it("notice clears on filter change", async () => {
    handler = withRow({ status: "classified" }, () => json({ id: ID, status: "unit_processing", changed: true }));
    render(<DocumentTable />);
    fireEvent.click(await screen.findByRole("button", { name: "Chuyển đơn vị xử lý" }));
    await screen.findByText("Đã cập nhật");
    fireEvent.change(screen.getByLabelText("Trạng thái"), { target: { value: "done" } });
    expect(screen.queryByText("Đã cập nhật")).toBeNull();
  });

  it("notice timer is cleared on unmount", async () => {
    vi.useFakeTimers();
    handler = withRow({ status: "classified" }, () => json({ id: ID, status: "unit_processing", changed: true }));
    const { unmount } = render(<DocumentTable />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "Chuyển đơn vị xử lý" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const before = vi.getTimerCount();
    unmount();
    expect(vi.getTimerCount()).toBeLessThan(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("notice clears when the search box changes", async () => {
    handler = withRow({ status: "classified" }, () => json({ id: ID, status: "unit_processing", changed: true }));
    render(<DocumentTable />);
    fireEvent.click(await screen.findByRole("button", { name: "Chuyển đơn vị xử lý" }));
    await screen.findByText("Đã cập nhật");
    fireEvent.change(screen.getByLabelText("Tìm theo tên tệp"), { target: { value: "abc" } });
    await waitFor(() => expect(screen.queryByText("Đã cập nhật")).toBeNull());
  });
});
