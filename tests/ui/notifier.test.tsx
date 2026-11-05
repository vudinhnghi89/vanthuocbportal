// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Notifier } from "@/components/Notifier";
import { NotificationBell } from "@/components/NotificationBell";
import { resetNotifications } from "@/hooks/notifications";
import { FakeEventSource } from "./fake-event-source";

const ev = (o: Record<string, unknown> = {}) => ({
  type: "document.status", documentId: "d1", filename: "cv-01.pdf", from: "rule_checking", status: "classified",
  needsManual: false, matchMethod: "single", mainUnit: { id: 1, name: "Phòng A" }, infoUnit: { id: 2, name: "Phòng B" },
  at: "2026-03-01T00:00:00.000Z", ...o,
});
const emit = (o?: Record<string, unknown>) => act(() => FakeEventSource.last.emit(ev(o)));

function App() {
  return (
    <>
      <NotificationBell />
      <Notifier />
    </>
  );
}
const region = () => screen.getByRole("region", { name: "Thông báo mới" });

beforeEach(() => {
  FakeEventSource.reset();
  resetNotifications();
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Notifier toasts", () => {
  it("live region is polite", () => {
    render(<App />);
    expect(region().getAttribute("aria-live")).toBe("polite");
  });

  it("classified with units shows both units", () => {
    render(<App />);
    emit();
    expect(within(region()).getByText(
      'Văn bản "cv-01.pdf" đã phân loại — Đơn vị xử lý chính: Phòng A; Đơn vị nhận thông tin: Phòng B',
    )).toBeTruthy();
  });

  it("classified with a missing unit shows a dash", () => {
    render(<App />);
    emit({ infoUnit: null });
    expect(within(region()).getByText(/Đơn vị nhận thông tin: —$/)).toBeTruthy();
  });

  it.each([{ needsManual: true }, { matchMethod: "none" }])("manual classification message (%j)", (o) => {
    render(<App />);
    emit(o);
    expect(within(region()).getByText(
      'Văn bản "cv-01.pdf" chưa khớp rule → chuyển Ban thư ký để phân loại thủ công',
    )).toBeTruthy();
  });

  it("failed message", () => {
    render(<App />);
    emit({ status: "failed" });
    expect(within(region()).getByText('Văn bản "cv-01.pdf" xử lý lỗi')).toBeTruthy();
  });

  it.each(["queued", "ocr_processing", "rule_checking", "unit_processing", "done"])("no toast and no unread for %s", (status) => {
    render(<App />);
    emit({ status });
    expect(within(region()).queryByRole("listitem")).toBeNull();
    expect(screen.queryByTestId("bell-count")).toBeNull();
  });

  it("renders file names as text, never HTML", () => {
    render(<App />);
    emit({ filename: "<img src=x onerror=alert(1)>.pdf" });
    expect(region().querySelector("img")).toBeNull();
    expect(region().textContent).toContain("<img src=x onerror=alert(1)>.pdf");
  });

  it("auto-dismisses after ~8s and leaves no timers", () => {
    vi.useFakeTimers();
    render(<App />);
    emit();
    expect(within(region()).getAllByRole("listitem")).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(7900);
    });
    expect(within(region()).getAllByRole("listitem")).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(within(region()).queryByRole("listitem")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dismiss button removes the toast and its timer; unmount clears timers", () => {
    vi.useFakeTimers();
    const { unmount } = render(<App />);
    emit();
    fireEvent.click(screen.getByRole("button", { name: "Đóng thông báo" }));
    expect(within(region()).queryByRole("listitem")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    emit({ documentId: "d2" });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows at most 4 toasts (newest kept)", () => {
    render(<App />);
    for (let i = 1; i <= 6; i++) emit({ filename: `f${i}.pdf` });
    const items = within(region()).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toContain("f3.pdf");
    expect(items[3].textContent).toContain("f6.pdf");
  });
});

describe("NotificationBell", () => {
  it("counts unread, lists newest first, marks read on open", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Thông báo" })).toBeTruthy();
    emit({ filename: "a.pdf" });
    emit({ filename: "b.pdf", status: "failed" });
    expect(screen.getByTestId("bell-count").textContent).toBe("2");
    const bell = screen.getByRole("button", { name: "Thông báo, 2 chưa đọc" });
    expect(bell.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(bell);
    expect(screen.queryByTestId("bell-count")).toBeNull();
    const panel = screen.getByRole("region", { name: "Danh sách thông báo" });
    const items = within(panel).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('"b.pdf" xử lý lỗi');
    expect(items[1].textContent).toContain('"a.pdf" đã phân loại');
    expect(screen.getByRole("button", { name: "Thông báo" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("notifications arriving while open are read immediately", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Thông báo" }));
    emit();
    expect(screen.queryByTestId("bell-count")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Danh sách thông báo" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("keeps the last 30 only", () => {
    render(<App />);
    for (let i = 1; i <= 35; i++) emit({ filename: `f${i}.pdf` });
    expect(screen.getByTestId("bell-count").textContent).toBe("30");
    fireEvent.click(screen.getByRole("button", { name: /Thông báo/ }));
    const items = within(screen.getByRole("region", { name: "Danh sách thông báo" })).getAllByRole("listitem");
    expect(items).toHaveLength(30);
    expect(items[0].textContent).toContain("f35.pdf");
    expect(items[29].textContent).toContain("f6.pdf");
  });

  it("'Xóa' empties the list", () => {
    render(<App />);
    emit();
    fireEvent.click(screen.getByRole("button", { name: /Thông báo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Xóa" }));
    expect(screen.getByText("Chưa có thông báo")).toBeTruthy();
  });

  it("Escape closes the panel and returns focus to the bell; button toggles", () => {
    render(<App />);
    const bell = screen.getByRole("button", { name: "Thông báo" });
    fireEvent.click(bell);
    fireEvent.keyDown(screen.getByRole("button", { name: "Xóa" }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Danh sách thông báo" })).toBeNull();
    expect(document.activeElement).toBe(bell);
    fireEvent.click(bell);
    fireEvent.click(bell);
    expect(screen.queryByRole("region", { name: "Danh sách thông báo" })).toBeNull();
  });

  it("clicking outside closes the panel", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Thông báo" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("region", { name: "Danh sách thông báo" })).toBeNull();
  });
});
