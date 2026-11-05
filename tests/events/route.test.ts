import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/auth/config", () => ({ auth: () => authMock() }));

const state = vi.hoisted(() => ({ listeners: new Set<(e: unknown) => void>(), cap: false }));
vi.mock("@/server/events", () => {
  class TooManySubscribersError extends Error {
    constructor() {
      super("Quá nhiều kết nối thời gian thực");
    }
  }
  return {
    TooManySubscribersError,
    subscribe: (l: (e: unknown) => void) => {
      if (state.cap) throw new TooManySubscribersError();
      state.listeners.add(l);
      return () => state.listeners.delete(l);
    },
  };
});

import { GET } from "@/app/api/events/route";

const active = { user: { id: 1, username: "u", role: "user", active: true }, expires: "2099-01-01" };
const inactive = { user: { id: 1, username: "u", role: "user", active: false }, expires: "2099-01-01" };
const event = { type: "document.status", documentId: "d1", filename: "a.pdf", status: "classified" };

function reader(res: Response) {
  const r = res.body!.getReader();
  const dec = new TextDecoder();
  return {
    async read() {
      const { value, done } = await r.read();
      return done ? null : dec.decode(value);
    },
    cancel: () => r.cancel(),
  };
}
const parseFrame = (f: string) => Object.fromEntries(f.trim().split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));

beforeEach(() => {
  state.listeners.clear();
  state.cap = false;
  authMock.mockReset();
  authMock.mockResolvedValue(active);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/events", () => {
  it("401 JSON when unauthenticated or inactive, no subscription made", async () => {
    for (const s of [null, inactive]) {
      authMock.mockResolvedValue(s);
      const res = await GET(new Request("http://x/api/events"));
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Chưa đăng nhập" });
    }
    expect(state.listeners.size).toBe(0);
  });

  it("503 when the subscriber cap is hit", async () => {
    state.cap = true;
    const res = await GET(new Request("http://x/api/events"));
    expect(res.status).toBe(503);
    expect(typeof (await res.json()).error).toBe("string");
  });

  it("sends SSE headers, retry + connected comment, then framed events with increasing ids", async () => {
    const res = await GET(new Request("http://x/api/events"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("connection")).toBe("keep-alive");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const r = reader(res);
    expect(await r.read()).toBe("retry: 3000\n\n: connected\n\n");
    for (const l of state.listeners) l(event);
    for (const l of state.listeners) l({ ...event, status: "failed" });
    const f1 = parseFrame((await r.read())!);
    expect(f1).toMatchObject({ id: "1", event: "document" });
    expect(JSON.parse(f1.data)).toEqual(event);
    expect(parseFrame((await r.read())!).id).toBe("2");
    await r.cancel();
    expect(state.listeners.size).toBe(0);
  });

  it("aborting the request unsubscribes and ends the stream", async () => {
    const ctl = new AbortController();
    const res = await GET(new Request("http://x/api/events", { signal: ctl.signal }));
    const r = reader(res);
    await r.read();
    expect(state.listeners.size).toBe(1);
    ctl.abort();
    expect(state.listeners.size).toBe(0);
    expect(await r.read()).toBeNull();
  });

  it("an already-aborted request does not leak a subscription", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await GET(new Request("http://x/api/events", { signal: ctl.signal }));
    expect(state.listeners.size).toBe(0);
  });

  it("pings every 25s and clears timers on close", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    const res = await GET(new Request("http://x/api/events", { signal: ctl.signal }));
    const r = reader(res);
    await r.read();
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await r.read()).toBe(": ping\n\n");
    ctl.abort();
    expect(vi.getTimerCount()).toBe(0);
    expect(state.listeners.size).toBe(0);
  });

  it("re-validates the session every 5 minutes and closes when the user became inactive", async () => {
    vi.useFakeTimers();
    const res = await GET(new Request("http://x/api/events"));
    const r = reader(res);
    await r.read();
    const calls = authMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    // chỉ còn ping trong hàng đợi, chưa kiểm tra lại phiên
    expect(authMock.mock.calls.length).toBe(calls);
    authMock.mockResolvedValue(inactive);
    await vi.advanceTimersByTimeAsync(1);
    expect(authMock.mock.calls.length).toBe(calls + 1);
    let last: string | null = "";
    while ((last = await r.read()) !== null) expect(last).toBe(": ping\n\n");
    expect(state.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the stream when re-validation fails for infrastructure reasons", async () => {
    vi.useFakeTimers();
    const res = await GET(new Request("http://x/api/events"));
    const r = reader(res);
    await r.read();
    authMock.mockRejectedValue(new Error("db down"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(state.listeners.size).toBe(1);
    await r.cancel();
  });
});
