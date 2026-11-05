// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { navigation, useDocumentEvents } from "@/hooks/useDocumentEvents";
import { FakeEventSource } from "./fake-event-source";

const ev = (o: Record<string, unknown> = {}) => ({
  type: "document.status", documentId: "d1", filename: "a.pdf", from: "rule_checking", status: "classified",
  needsManual: false, matchMethod: "single", mainUnit: null, infoUnit: null, at: "2026-03-01T00:00:00.000Z", ...o,
});

function Probe({ onEvent }: { onEvent?: (e: unknown) => void }) {
  const { connection } = useDocumentEvents(onEvent);
  return <p data-testid="c">{connection}</p>;
}
const state = () => screen.getByTestId("c").textContent;

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useDocumentEvents", () => {
  it("opens one EventSource for /api/events shared by all consumers and closes on last unmount", () => {
    const a = render(<Probe />);
    const b = render(<Probe />);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last.url).toBe("/api/events");
    a.unmount();
    expect(FakeEventSource.last.closed).toBe(false);
    b.unmount();
    expect(FakeEventSource.last.closed).toBe(true);
  });

  it("tracks connecting -> open -> reconnecting -> open", () => {
    render(<Probe />);
    expect(state()).toBe("connecting");
    act(() => FakeEventSource.last.open());
    expect(state()).toBe("open");
    act(() => FakeEventSource.last.fail());
    expect(state()).toBe("reconnecting");
    act(() => FakeEventSource.last.open());
    expect(state()).toBe("open");
    expect(FakeEventSource.instances).toHaveLength(1); // trình duyệt tự kết nối lại
  });

  it("delivers parsed events and dispatches documents:changed per message; ignores garbage", () => {
    const got: unknown[] = [];
    const changed = vi.fn();
    window.addEventListener("documents:changed", changed);
    render(<Probe onEvent={(e) => got.push(e)} />);
    act(() => FakeEventSource.last.open());
    act(() => {
      FakeEventSource.last.emit(ev());
      FakeEventSource.last.emit("not json");
      FakeEventSource.last.emit({ nope: 1 });
    });
    expect(got).toEqual([ev()]);
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener("documents:changed", changed);
  });

  it("a resync message dispatches documents:changed once and is not delivered as an event", () => {
    const got: unknown[] = [];
    const changed = vi.fn();
    window.addEventListener("documents:changed", changed);
    render(<Probe onEvent={(e) => got.push(e)} />);
    act(() => FakeEventSource.last.open());
    act(() => FakeEventSource.last.emit({}, "resync"));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(got).toEqual([]);
    window.removeEventListener("documents:changed", changed);
  });

  it("dispatches one catch-up documents:changed on re-open, not on first open", () => {
    const changed = vi.fn();
    window.addEventListener("documents:changed", changed);
    render(<Probe />);
    act(() => FakeEventSource.last.open());
    expect(changed).not.toHaveBeenCalled();
    act(() => FakeEventSource.last.fail());
    act(() => FakeEventSource.last.open());
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener("documents:changed", changed);
  });

  it("recreates the source after the browser gives up (CLOSED), and clears the timer on unmount", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 503 })); // thăm dò phiên: chưa hết hạn
    const { unmount } = render(<Probe />);
    act(() => FakeEventSource.last.fail(true));
    expect(state()).toBe("reconnecting");
    expect(FakeEventSource.instances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => FakeEventSource.last.fail(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // để thăm dò hoàn tất và hẹn giờ mở lại
    });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("stays 'connecting' without crashing when EventSource is unavailable", () => {
    vi.unstubAllGlobals();
    render(<Probe />);
    expect(state()).toBe("connecting");
  });
});

describe("useDocumentEvents: phiên hết hạn", () => {
  it("stream đóng hẳn, thăm dò trả 401 -> chuyển về /login và không mở lại", async () => {
    vi.useFakeTimers();
    const toLogin = vi.spyOn(navigation, "toLogin").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({ status: 401 });
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    act(() => FakeEventSource.last.open());
    act(() => FakeEventSource.last.fail(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/units", expect.objectContaining({ method: "GET", cache: "no-store" }));
    expect(toLogin).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    toLogin.mockRestore();
  });

  it("thăm dò trả 503 hoặc lỗi mạng -> vẫn thử mở lại, không chuyển trang", async () => {
    vi.useFakeTimers();
    const toLogin = vi.spyOn(navigation, "toLogin").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ status: 503 }).mockRejectedValueOnce(new Error("net")));
    render(<Probe />);
    act(() => FakeEventSource.last.open());
    act(() => FakeEventSource.last.fail(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => FakeEventSource.last.fail(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(toLogin).not.toHaveBeenCalled();
    toLogin.mockRestore();
  });
});
