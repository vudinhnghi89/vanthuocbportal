// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { DocumentDetailView } from "@/components/DocumentDetailView";
import type { DocumentDetail } from "@/server/document-detail";

const ID = "11111111-1111-4111-8111-111111111111";
const detail = (o: Partial<DocumentDetail> = {}): DocumentDetail => ({
  id: ID, filename: "cv-01.pdf", status: "done", error: null, needsManual: false, matchMethod: "single", matchedRuleId: 1,
  mainUnit: { id: 1, name: "Phòng A" }, infoUnit: null, uploadedBy: "lan",
  createdAt: "2026-03-01T01:00:00.000Z", updatedAt: "2026-03-01T17:30:00.000Z",
  extracted: { tieu_de: "Tiêu đề" }, markdown: "# Nội dung", markdownTruncated: false, hasPdf: true,
  events: [
    { at: "2026-03-01T17:30:00.000Z", from: null, to: "queued", actor: "lan", note: null },
    { at: "2026-03-01T17:31:00.000Z", from: "queued", to: "ocr_processing", actor: null, note: "ghi chú" },
  ],
  ...o,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const fetchMock = vi.fn((url: string, init?: RequestInit) => handler(String(url), init));
const UNITS = [{ id: 1, name: "Phòng A" }, { id: 2, name: "Phòng B" }];
const manual = () => detail({ status: "classified", needsManual: true, matchMethod: "none", mainUnit: null });

beforeEach(() => {
  refresh.mockClear();
  fetchMock.mockClear();
  handler = (url) => (url.startsWith("/api/units") ? json(UNITS) : json({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DocumentDetailView", () => {
  it("shows header, match text, VN time and a safe PDF link", () => {
    render(<DocumentDetailView detail={detail()} isAdmin={false} />);
    expect(screen.getByRole("heading", { level: 1, name: "cv-01.pdf" })).toBeTruthy();
    expect(screen.getByText("Xong")).toBeTruthy();
    expect(screen.getByText("Khớp 1 rule")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Xem file PDF gốc" });
    expect(link.getAttribute("href")).toBe(`/api/documents/${ID}/file`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it.each([
    ["agent", "AI chọn rule"],
    ["none", "Không khớp rule nào"],
  ] as const)("match method %s -> %s", (m, text) => {
    render(<DocumentDetailView detail={detail({ matchMethod: m })} isAdmin={false} />);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("no PDF link when hasPdf is false", () => {
    render(<DocumentDetailView detail={detail({ hasPdf: false })} isAdmin={false} />);
    expect(screen.queryByRole("link", { name: "Xem file PDF gốc" })).toBeNull();
  });

  it("renders markdown as plain text, never HTML", () => {
    const evil = '<script>window.__x=1</script><img src=x onerror="window.__y=1">';
    const { container } = render(<DocumentDetailView detail={detail({ markdown: evil })} isAdmin={false} />);
    const pre = container.querySelector("pre")!;
    expect(pre.textContent).toBe(evil);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("shows truncation note", () => {
    render(<DocumentDetailView detail={detail({ markdownTruncated: true })} isAdmin={false} />);
    expect(screen.getByText(/đã cắt bớt/)).toBeTruthy();
  });

  it("tabs switch to JSON (pretty, text) and history (VN time, actor, note)", () => {
    const { container } = render(<DocumentDetailView detail={detail({ extracted: { tieu_de: "<b>x</b>" } })} isAdmin={false} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Dữ liệu trích xuất (JSON)" }));
    expect(container.querySelector("pre")!.textContent).toBe(JSON.stringify({ tieu_de: "<b>x</b>" }, null, 2));
    expect(container.querySelector("b")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Lịch sử trạng thái" }));
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3);
    // 2026-03-01T17:30Z = 00:30 02/03 giờ VN
    expect(rows[1].textContent).toMatch(/00:30/);
    expect(within(rows[1]).getByText("lan")).toBeTruthy();
    expect(within(rows[1]).getByText("Hàng đợi")).toBeTruthy();
    expect(within(rows[2]).getByText("Hệ thống")).toBeTruthy();
    expect(within(rows[2]).getByText("ghi chú")).toBeTruthy();
  });

  describe("failed", () => {
    it("shows error and retries", async () => {
      handler = (url) => (url.endsWith("/retry") ? json({ status: "queued" }) : json({}));
      render(<DocumentDetailView detail={detail({ status: "failed", error: "OCR lỗi" })} isAdmin={false} />);
      expect(screen.getByRole("alert").textContent).toContain("OCR lỗi");
      fireEvent.click(screen.getByRole("button", { name: "Chạy lại" }));
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`/api/documents/${ID}/retry`);
      expect(init!.method).toBe("POST");
      expect(screen.getByText("Đã đưa văn bản vào hàng đợi chạy lại")).toBeTruthy();
    });
    it("shows server error on retry failure", async () => {
      handler = () => json({ error: "Hàng đợi bận" }, 503);
      render(<DocumentDetailView detail={detail({ status: "failed", error: "x" })} isAdmin={false} />);
      fireEvent.click(screen.getByRole("button", { name: "Chạy lại" }));
      expect(await screen.findByText("Hàng đợi bận")).toBeTruthy();
    });
    it("no retry button when not failed", () => {
      render(<DocumentDetailView detail={detail()} isAdmin={false} />);
      expect(screen.queryByRole("button", { name: "Chạy lại" })).toBeNull();
    });
  });

  describe("classify form", () => {
    it.each([
      ["done", false],
      ["classified", false],
      ["rule_checking", true],
      ["unit_processing", true],
    ] as const)("hidden for status=%s needsManual=%s", (status, needsManual) => {
      render(<DocumentDetailView detail={detail({ status, needsManual })} isAdmin={false} />);
      expect(screen.queryByRole("button", { name: "Xác nhận phân loại" })).toBeNull();
    });

    it("lists active units, preselects nothing, submits payload, shows notice and refreshes", async () => {
      handler = (url) => (url.startsWith("/api/units") ? json(UNITS) : json({ ok: true }));
      render(<DocumentDetailView detail={manual()} isAdmin={false} />);
      const main = (await screen.findByLabelText("Đơn vị xử lý chính")) as HTMLSelectElement;
      const info = screen.getByLabelText("Đơn vị nhận thông tin") as HTMLSelectElement;
      await waitFor(() => expect(within(main).getAllByRole("option")).toHaveLength(3));
      expect(main.value).toBe("");
      expect(info.value).toBe("");
      expect(within(info).getByRole("option", { name: "Không có" })).toBeTruthy();
      const submit = screen.getByRole("button", { name: "Xác nhận phân loại" }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      fireEvent.change(main, { target: { value: "1" } });
      fireEvent.change(info, { target: { value: "2" } });
      fireEvent.click(submit);
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/classify"))!;
      expect(call[0]).toBe(`/api/documents/${ID}/classify`);
      expect(call[1]!.method).toBe("POST");
      expect(JSON.parse(String(call[1]!.body))).toEqual({ mainUnitId: 1, infoUnitId: 2 });
      expect(screen.getByText("Đã lưu phân loại thủ công")).toBeTruthy();
    });

    it("info 'Không có' sends null; disables while in flight", async () => {
      let release!: (r: Response) => void;
      handler = (url) => (url.startsWith("/api/units") ? json(UNITS) : new Promise<Response>((r) => (release = r)));
      render(<DocumentDetailView detail={manual()} isAdmin={false} />);
      const main = (await screen.findByLabelText("Đơn vị xử lý chính")) as HTMLSelectElement;
      await waitFor(() => expect(within(main).getAllByRole("option")).toHaveLength(3));
      fireEvent.change(main, { target: { value: "2" } });
      const submit = screen.getByRole("button", { name: "Xác nhận phân loại" }) as HTMLButtonElement;
      fireEvent.click(submit);
      await waitFor(() => expect(submit.disabled).toBe(true));
      fireEvent.click(submit);
      expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/classify"))).toHaveLength(1);
      const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/classify"))!;
      expect(JSON.parse(String(call[1]!.body))).toEqual({ mainUnitId: 2, infoUnitId: null });
      release(json({ ok: true }));
      await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it("shows server error and network error", async () => {
      handler = (url) => (url.startsWith("/api/units") ? json(UNITS) : json({ error: "Văn bản này không cần phân loại thủ công" }, 409));
      render(<DocumentDetailView detail={manual()} isAdmin={false} />);
      const main = (await screen.findByLabelText("Đơn vị xử lý chính")) as HTMLSelectElement;
      await waitFor(() => expect(within(main).getAllByRole("option")).toHaveLength(3));
      fireEvent.change(main, { target: { value: "1" } });
      fireEvent.click(screen.getByRole("button", { name: "Xác nhận phân loại" }));
      expect(await screen.findByText("Văn bản này không cần phân loại thủ công")).toBeTruthy();
      expect(refresh).not.toHaveBeenCalled();
      handler = (url) => {
        if (url.startsWith("/api/units")) return json(UNITS);
        throw new TypeError("fetch failed");
      };
      fireEvent.click(screen.getByRole("button", { name: "Xác nhận phân loại" }));
      expect(await screen.findByText(/Không thể kết nối máy chủ/)).toBeTruthy();
    });

    it("shows error when units fail to load", async () => {
      handler = () => json({ error: "boom" }, 500);
      render(<DocumentDetailView detail={manual()} isAdmin={false} />);
      expect(await screen.findByText("boom")).toBeTruthy();
    });
  });
});
