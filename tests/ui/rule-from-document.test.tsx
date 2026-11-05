// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { RulesManager } from "@/app/admin/rules/rules-manager";
import { DocumentDetailView } from "@/components/DocumentDetailView";
import type { DocumentDetail } from "@/server/document-detail";

const ID = "11111111-1111-4111-8111-111111111111";
const units = [
  { id: 1, name: "Phòng A", isSecretariat: false, active: true },
  { id: 2, name: "Phòng B", isSecretariat: false, active: true },
];
const draft = {
  issuer: "Sở Tài chính", docType: "Thông báo", title: "Lịch họp", summary: "Họp giao ban",
  mainUnitId: 2, infoUnitId: 1, documentId: ID, filename: "cv <b>1</b>.pdf",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
const fetchMock = vi.fn();

beforeEach(() => {
  refresh.mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({ id: 9 }, 201));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RulesManager with initialDraft", () => {
  const renderIt = (props: Record<string, unknown> = {}) =>
    render(<RulesManager rules={[]} units={units} allUnits={units} q="" initialDraft={draft} {...props} />);

  it("prefills the create form and shows banner with link back (text only)", () => {
    const { container } = renderIt();
    expect((screen.getByLabelText("Cơ quan ban hành") as HTMLInputElement).value).toBe("Sở Tài chính");
    expect((screen.getByLabelText("Loại văn bản") as HTMLInputElement).value).toBe("Thông báo");
    expect((screen.getByLabelText("Tiêu đề") as HTMLInputElement).value).toBe("Lịch họp");
    expect((screen.getByLabelText("Trích yếu") as HTMLTextAreaElement).value).toBe("Họp giao ban");
    expect((screen.getByLabelText("Đơn vị chủ trì") as HTMLSelectElement).value).toBe("2");
    expect((screen.getByLabelText("Đơn vị nhận để biết") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByLabelText("Độ ưu tiên") as HTMLInputElement).value).toBe("0");
    expect(screen.getByText(/Đang tạo rule từ văn bản "cv <b>1<\/b>.pdf"/)).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByRole("link", { name: "Quay lại văn bản" }).getAttribute("href")).toBe(`/documents/${ID}`);
  });

  it("ignores units that are not active options", () => {
    renderIt({ initialDraft: { ...draft, mainUnitId: 99, infoUnitId: 98 } });
    expect((screen.getByLabelText("Đơn vị chủ trì") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByLabelText("Đơn vị nhận để biết") as HTMLSelectElement).value).toBe("");
  });

  it("admin can edit, saves via POST /api/admin/rules, then sees a link back", async () => {
    renderIt();
    fireEvent.change(screen.getByLabelText("Tiêu đề"), { target: { value: "Sửa" } });
    fireEvent.click(screen.getByRole("button", { name: "Thêm quy tắc" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/rules");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      issuer: "Sở Tài chính", docType: "Thông báo", title: "Sửa", summary: "Họp giao ban", mainUnitId: 2, infoUnitId: 1, priority: 0,
    });
    expect(await screen.findByText(/Đã lưu quy tắc mới/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Quay lại văn bản" })[0].getAttribute("href")).toBe(`/documents/${ID}`);
  });

  it("failed save shows the error and no success message", async () => {
    fetchMock.mockResolvedValue(json({ error: "Đơn vị phải tồn tại" }, 400));
    renderIt();
    fireEvent.click(screen.getByRole("button", { name: "Thêm quy tắc" }));
    expect(await screen.findByText("Đơn vị phải tồn tại")).toBeTruthy();
    expect(screen.queryByText(/Đã lưu quy tắc mới/)).toBeNull();
  });

  it("shows a small notice and an empty form when the draft was invalid", () => {
    render(<RulesManager rules={[]} units={units} allUnits={units} q="" initialDraft={null} draftNotice="Không tìm thấy văn bản để tạo rule" />);
    expect(screen.getByText("Không tìm thấy văn bản để tạo rule")).toBeTruthy();
    expect((screen.getByLabelText("Cơ quan ban hành") as HTMLInputElement).value).toBe("");
  });

  it("behaves as before without a draft", () => {
    render(<RulesManager rules={[]} units={units} allUnits={units} q="" />);
    expect(screen.queryByText(/Đang tạo rule từ văn bản/)).toBeNull();
    expect((screen.getByLabelText("Đơn vị chủ trì") as HTMLSelectElement).value).toBe("1");
  });
});

describe("create-rule button on the detail page", () => {
  const detail = (o: Partial<DocumentDetail> = {}): DocumentDetail => ({
    id: ID, filename: "a.pdf", status: "classified", error: null, needsManual: true, matchMethod: "none", matchedRuleId: null,
    mainUnit: null, infoUnit: null, uploadedBy: "lan", createdAt: "2026-03-01T01:00:00.000Z", updatedAt: "2026-03-01T01:00:00.000Z",
    extracted: null, markdown: "", markdownTruncated: false, hasPdf: false, events: [], ...o,
  });
  const HINT = "Liên hệ quản trị viên để thêm rule cho loại văn bản này.";
  beforeEach(() => fetchMock.mockResolvedValue(json([])));

  it("admin sees a link to the prefilled rule form; no hint", () => {
    render(<DocumentDetailView detail={detail()} isAdmin />);
    expect(screen.getByRole("link", { name: "Tạo rule từ văn bản này" }).getAttribute("href")).toBe(`/admin/rules?fromDocument=${ID}`);
    expect(screen.queryByText(HINT)).toBeNull();
  });
  it("admin sees it also after manual classification", () => {
    render(<DocumentDetailView detail={detail({ needsManual: false, matchMethod: "none", mainUnit: { id: 1, name: "A" } })} isAdmin />);
    expect(screen.getByRole("link", { name: "Tạo rule từ văn bản này" })).toBeTruthy();
  });
  it("non-admin sees the hint only for manual documents", () => {
    const { unmount } = render(<DocumentDetailView detail={detail()} isAdmin={false} />);
    expect(screen.queryByRole("link", { name: "Tạo rule từ văn bản này" })).toBeNull();
    expect(screen.getByText(HINT)).toBeTruthy();
    unmount();
    render(<DocumentDetailView detail={detail({ needsManual: false, matchMethod: "single" })} isAdmin={false} />);
    expect(screen.queryByText(HINT)).toBeNull();
  });
  it("admin sees no button for rule-matched documents", () => {
    render(<DocumentDetailView detail={detail({ needsManual: false, matchMethod: "single" })} isAdmin />);
    expect(screen.queryByRole("link", { name: "Tạo rule từ văn bản này" })).toBeNull();
  });
});
