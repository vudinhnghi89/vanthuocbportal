// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DocumentTable } from "@/components/DocumentTable";

type Item = {
  id: string; filename: string; status: string; error: string | null; needsManual: boolean;
  matchMethod: string | null; matchedRuleId: number | null;
  mainUnit: { id: number; name: string } | null; infoUnit: { id: number; name: string } | null;
  uploadedBy: string | null; createdAt: string; updatedAt: string;
};
const item = (o: Partial<Item> = {}): Item => ({
  id: "11111111-1111-4111-8111-111111111111", filename: "cv-01.pdf", status: "done", error: null, needsManual: false,
  matchMethod: "single", matchedRuleId: 1, mainUnit: { id: 1, name: "Phòng A" }, infoUnit: { id: 2, name: "Phòng B" },
  uploadedBy: "lan", createdAt: "2026-03-01T01:00:00.000Z", updatedAt: "2026-03-01T17:30:00.000Z", ...o,
});
const page = (items: Item[], total = items.length, p = 1) => ({ items, total, page: p, pageSize: 20 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const fetchMock = vi.fn((url: string, init?: RequestInit) => handler(String(url), init));
const docCalls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/documents?"));
const lastDocQuery = () => new URLSearchParams(docCalls().at(-1)!.split("?")[1]);

const defaultHandler: Handler = (url) => {
  if (url.startsWith("/api/units")) return json([{ id: 1, name: "Phòng A", isSecretariat: false }, { id: 2, name: "Phòng B", isSecretariat: false }]);
  return json(page([item()]));
};

beforeEach(() => {
  handler = defaultHandler;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DocumentTable", () => {
  it("renders rows with Vietnamese labels and VN time", async () => {
    render(<DocumentTable />);
    expect(screen.getByText("Đang tải…")).toBeTruthy();
    expect(await screen.findByText("cv-01.pdf")).toBeTruthy();
    const row = screen.getByText("cv-01.pdf").closest("tr")!;
    expect(within(row).getByText("Xong")).toBeTruthy();
    expect(within(row).getByText("Phòng A")).toBeTruthy();
    expect(within(row).getByText("Phòng B")).toBeTruthy();
    // 2026-03-01T17:30Z = 02/03/2026 00:30 giờ VN
    expect(row.textContent).toMatch(/00:30/);
    expect(row.textContent).toMatch(/2\/3\/2026|02\/03\/2026/);
    expect(screen.getByRole("columnheader", { name: "Tên văn bản" }).getAttribute("scope")).toBe("col");
    expect(screen.getByText(/Tổng: 1 văn bản/)).toBeTruthy();
    expect(screen.getByText("Trang 1/1")).toBeTruthy();
    expect(lastDocQuery().get("page")).toBe("1");
  });

  it("shows needsManual badge", async () => {
    handler = (u) => (u.startsWith("/api/units") ? json([]) : json(page([item({ needsManual: true })])));
    render(<DocumentTable />);
    const row = (await screen.findByText("cv-01.pdf")).closest("tr")!;
    expect(within(row).getByText("Cần phân loại thủ công")).toBeTruthy();
  });

  it("empty states", async () => {
    handler = (u) => (u.startsWith("/api/units") ? json([]) : json(page([])));
    render(<DocumentTable />);
    expect(await screen.findByText("Chưa có văn bản nào")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Trạng thái"), { target: { value: "failed" } });
    expect(await screen.findByText("Không có văn bản khớp bộ lọc")).toBeTruthy();
  });

  it("error state with retry", async () => {
    let fail = true;
    handler = (u) => {
      if (u.startsWith("/api/units")) return json([]);
      if (fail) return json({ error: "Lỗi máy chủ" }, 500);
      return json(page([item()]));
    };
    render(<DocumentTable />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Lỗi máy chủ/);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(await screen.findByText("cv-01.pdf")).toBeTruthy();
  });

  it("network error shows error state", async () => {
    handler = (u) => {
      if (u.startsWith("/api/units")) return json([]);
      throw new TypeError("network");
    };
    render(<DocumentTable />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Không tải được/);
  });

  it("filter changes issue the right query and reset the page", async () => {
    handler = (u) => (u.startsWith("/api/units") ? defaultHandler(u) : json(page([item()], 45, Number(new URLSearchParams(u.split("?")[1]).get("page")))));
    render(<DocumentTable />);
    await screen.findByText("cv-01.pdf");
    expect(screen.getByText("Trang 1/3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sau" }));
    await screen.findByText("Trang 2/3");
    expect(lastDocQuery().get("page")).toBe("2");

    fireEvent.change(screen.getByLabelText("Trạng thái"), { target: { value: "failed" } });
    await waitFor(() => expect(lastDocQuery().get("status")).toBe("failed"));
    expect(lastDocQuery().get("page")).toBe("1");

    await screen.findByText("Phòng A", { selector: "option" });
    fireEvent.change(screen.getByLabelText("Đơn vị"), { target: { value: "2" } });
    await waitFor(() => expect(lastDocQuery().get("unit")).toBe("2"));
    fireEvent.click(screen.getByLabelText("Cần phân loại thủ công"));
    await waitFor(() => expect(lastDocQuery().get("needsManual")).toBe("true"));
    fireEvent.change(screen.getByLabelText("Từ ngày"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("Đến ngày"), { target: { value: "2026-03-31" } });
    await waitFor(() => expect(lastDocQuery().get("to")).toBe("2026-03-31"));
    const q = lastDocQuery();
    expect([q.get("status"), q.get("unit"), q.get("needsManual"), q.get("from"), q.get("page")]).toEqual([
      "failed", "2", "true", "2026-03-01", "1",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Xóa bộ lọc" }));
    await waitFor(() => expect(lastDocQuery().get("status")).toBeNull());
    const c = lastDocQuery();
    expect([c.get("unit"), c.get("needsManual"), c.get("from"), c.get("to"), c.get("q")]).toEqual([null, null, null, null, null]);
  });

  it("does not request when from > to is entered; shows message", async () => {
    render(<DocumentTable />);
    await screen.findByText("cv-01.pdf");
    fireEvent.change(screen.getByLabelText("Từ ngày"), { target: { value: "2026-03-10" } });
    const before = docCalls().length;
    fireEvent.change(screen.getByLabelText("Đến ngày"), { target: { value: "2026-03-01" } });
    expect(await screen.findByText("Ngày bắt đầu phải trước hoặc bằng ngày kết thúc")).toBeTruthy();
    expect(docCalls().length).toBe(before + 0);
  });

  it("debounces search by ~300ms", async () => {
    render(<DocumentTable />);
    await screen.findByText("cv-01.pdf");
    vi.useFakeTimers();
    const n = docCalls().length;
    const box = screen.getByLabelText("Tìm theo tên tệp");
    fireEvent.change(box, { target: { value: "c" } });
    fireEvent.change(box, { target: { value: "công" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(docCalls().length).toBe(n);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(docCalls().length).toBe(n + 1);
    expect(lastDocQuery().get("q")).toBe("công");
  });

  it("ignores stale responses of superseded requests", async () => {
    const resolvers: Record<string, (r: Response) => void> = {};
    handler = (u, init) => {
      if (u.startsWith("/api/units")) return json([]);
      const st = new URLSearchParams(u.split("?")[1]).get("status") ?? "all";
      return new Promise<Response>((res, rej) => {
        resolvers[st] = res;
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      });
    };
    render(<DocumentTable />);
    await waitFor(() => expect(resolvers.all).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Trạng thái"), { target: { value: "failed" } });
    await waitFor(() => expect(resolvers.failed).toBeTruthy());
    await act(async () => {
      resolvers.failed(json(page([item({ filename: "new.pdf", status: "failed", error: "x" })])));
    });
    expect(await screen.findByText("new.pdf")).toBeTruthy();
    await act(async () => {
      resolvers.all(json(page([item({ filename: "old.pdf" })])));
    });
    expect(screen.queryByText("old.pdf")).toBeNull();
    expect(screen.getByText("new.pdf")).toBeTruthy();
  });

  it("failed row shows truncated error with title and a retry button that calls the endpoint then refetches", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const long = "Lỗi ".repeat(100);
    handler = (u, init) => {
      if (u.startsWith("/api/units")) return json([]);
      if (u === `/api/documents/${id}/retry` && init?.method === "POST") return json({ status: "queued", alreadyQueued: false });
      return json(page([item({ id, status: "failed", error: long })]));
    };
    render(<DocumentTable />);
    const row = (await screen.findByText("cv-01.pdf")).closest("tr")!;
    const err = within(row).getByTitle(long.trim());
    expect(err).toBeTruthy();
    const n = docCalls().length;
    fireEvent.click(within(row).getByRole("button", { name: "Chạy lại" }));
    await waitFor(() => expect(docCalls().length).toBe(n + 1));
    expect(fetchMock.mock.calls.some((c) => c[0] === `/api/documents/${id}/retry` && (c[1] as RequestInit).method === "POST")).toBe(true);
  });

  it("shows the server message when retry is rejected", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    handler = (u) => {
      if (u.startsWith("/api/units")) return json([]);
      if (u.endsWith("/retry")) return json({ error: "Chỉ có thể chạy lại văn bản đang ở trạng thái lỗi" }, 409);
      return json(page([item({ id, status: "failed", error: "e" })]));
    };
    render(<DocumentTable />);
    fireEvent.click(await screen.findByRole("button", { name: "Chạy lại" }));
    expect((await screen.findByText("Chỉ có thể chạy lại văn bản đang ở trạng thái lỗi"))).toBeTruthy();
  });

  it("non-failed rows have no retry button", async () => {
    render(<DocumentTable />);
    await screen.findByText("cv-01.pdf");
    expect(screen.queryByRole("button", { name: "Chạy lại" })).toBeNull();
  });

  it("refetches on documents:uploaded", async () => {
    render(<DocumentTable />);
    await screen.findByText("cv-01.pdf");
    const n = docCalls().length;
    act(() => {
      window.dispatchEvent(new CustomEvent("documents:uploaded"));
    });
    await waitFor(() => expect(docCalls().length).toBe(n + 1));
  });

  describe("polling", () => {
    const setVisibility = (v: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
    };
    afterEach(() => setVisibility("visible"));

    it("polls every 15s while visible and pauses when hidden", async () => {
      vi.useFakeTimers();
      render(<DocumentTable />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("cv-01.pdf")).toBeTruthy();
      const n = docCalls().length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(docCalls().length).toBe(n + 1);

      setVisibility("hidden");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(docCalls().length).toBe(n + 1);

      setVisibility("visible");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(docCalls().length).toBe(n + 2); // làm mới ngay khi hiện lại
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(docCalls().length).toBe(n + 3);
    });

    it("does not tick while hidden even if the interval fires", async () => {
      vi.useFakeTimers();
      render(<DocumentTable />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      setVisibility("hidden");
      const n = docCalls().length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(45_000);
      });
      expect(docCalls().length).toBe(n);
    });
  });

  it("aborts the in-flight request on unmount and stops polling", async () => {
    let signal: AbortSignal | undefined;
    handler = (u, init) => {
      if (u.startsWith("/api/units")) return json([]);
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    };
    const { unmount } = render(<DocumentTable />);
    await waitFor(() => expect(signal).toBeTruthy());
    expect(signal!.aborted).toBe(false);
    unmount();
    expect(signal!.aborted).toBe(true);
    vi.useFakeTimers();
    const n = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new CustomEvent("documents:uploaded"));
    expect(fetchMock.mock.calls.length).toBe(n);
  });
});
