// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DocumentTable } from "@/components/DocumentTable";
import { FakeEventSource } from "./fake-event-source";

const row = (filename: string) => ({
  id: "11111111-1111-4111-8111-111111111111", filename, status: "done", error: null, needsManual: false,
  mainUnit: null, infoUnit: null, updatedAt: "2026-03-01T17:30:00.000Z",
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let docHandler: () => Response | Promise<Response>;
const fetchMock = vi.fn((url: string) => (String(url).startsWith("/api/units") ? json([]) : docHandler()));
const docCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/documents?")).length;
const ok = (name = "cv-01.pdf") => () => json({ items: [row(name)], total: 1, page: 1, pageSize: 20 });
const flush = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
  fetchMock.mockClear();
  docHandler = ok();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DocumentTable with SSE", () => {
  it("refetches once (debounced 300ms) for a burst of documents:changed", async () => {
    render(<DocumentTable />);
    await flush();
    act(() => FakeEventSource.last.open());
    const n = docCalls();
    act(() => {
      for (let i = 0; i < 3; i++) window.dispatchEvent(new CustomEvent("documents:changed"));
    });
    await flush(299);
    expect(docCalls()).toBe(n);
    await flush(2);
    expect(docCalls()).toBe(n + 1);
  });

  it("documents:uploaded is debounced the same way", async () => {
    render(<DocumentTable />);
    await flush();
    const n = docCalls();
    act(() => {
      window.dispatchEvent(new CustomEvent("documents:uploaded"));
    });
    await flush(300);
    expect(docCalls()).toBe(n + 1);
  });

  it("an SSE message refreshes the table", async () => {
    render(<DocumentTable />);
    await flush();
    act(() => FakeEventSource.last.open());
    docHandler = ok("moi.pdf");
    act(() => FakeEventSource.last.emit({ type: "document.status", documentId: "d", filename: "moi.pdf", status: "done" }));
    await flush(300);
    expect(screen.getByText("moi.pdf")).toBeTruthy();
  });

  it("does not poll while the connection is open; polls when not open", async () => {
    render(<DocumentTable />);
    await flush();
    act(() => FakeEventSource.last.open());
    const n = docCalls();
    await flush(60_000);
    expect(docCalls()).toBe(n);

    act(() => FakeEventSource.last.fail());
    await flush(15_000);
    expect(docCalls()).toBe(n + 1);
    await flush(15_000);
    expect(docCalls()).toBe(n + 2);

    act(() => FakeEventSource.last.open()); // mở lại: bù một lần rồi dừng polling
    await flush(300);
    const m = docCalls();
    expect(m).toBe(n + 3);
    await flush(60_000);
    expect(docCalls()).toBe(m);
  });

  it("clears every timer on unmount", async () => {
    const { unmount } = render(<DocumentTable />);
    await flush();
    act(() => FakeEventSource.last.open());
    act(() => {
      window.dispatchEvent(new CustomEvent("documents:changed"));
    });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("failed background refresh", () => {
  it("keeps loaded rows and shows an inline banner; retry recovers", async () => {
    render(<DocumentTable />);
    await flush();
    expect(screen.getByText("cv-01.pdf")).toBeTruthy();
    docHandler = () => json({ error: "Máy chủ lỗi" }, 500);
    act(() => {
      window.dispatchEvent(new CustomEvent("documents:changed"));
    });
    await flush(300);
    expect(screen.getByText("cv-01.pdf")).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Máy chủ lỗi");
    expect(alert.textContent).toContain("dữ liệu cũ");

    docHandler = ok("cv-02.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("cv-02.pdf")).toBeTruthy();
  });

  it("initial load failure still shows the error state without a table", async () => {
    docHandler = () => json({ error: "Máy chủ lỗi" }, 500);
    render(<DocumentTable />);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Máy chủ lỗi");
    expect(screen.getByRole("alert").textContent).not.toContain("dữ liệu cũ");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("a failure after changing the query shows the error state, not the old query's rows", async () => {
    render(<DocumentTable />);
    await flush();
    docHandler = () => json({ error: "Máy chủ lỗi" }, 500);
    fireEvent.change(screen.getByLabelText("Trạng thái"), { target: { value: "failed" } });
    await flush();
    expect(screen.getByRole("alert").textContent).not.toContain("dữ liệu cũ");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
