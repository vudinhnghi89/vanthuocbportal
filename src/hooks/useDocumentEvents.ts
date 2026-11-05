"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Status } from "@/lib/status";

export type ConnectionState = "connecting" | "open" | "reconnecting";

export type DocumentEvent = {
  type: "document.status";
  documentId: string;
  filename: string;
  from: Status;
  status: Status;
  needsManual: boolean;
  matchMethod: "single" | "agent" | "none" | null;
  mainUnit: { id: number; name: string } | null;
  infoUnit: { id: number; name: string } | null;
  at: string;
};

export const DOCUMENTS_CHANGED_EVENT = "documents:changed";
const EVENTS_URL = "/api/events";
const REOPEN_MS = 5000;
const PROBE_URL = "/api/units"; // nhẹ, cần đăng nhập; /api/events chỉ có GET (HEAD sẽ mở luồng)

/** Có thể thay trong test: chuyển về trang đăng nhập khi phiên đã hết hạn. */
export const navigation = {
  toLogin: () => {
    // Tải lại toàn trang (cố ý, không dùng router) để xóa trạng thái phiên cũ.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  },
};

/** true nếu máy chủ trả 401 (phiên hết hạn / tài khoản bị khóa). Lỗi mạng hoặc 5xx -> false (cứ thử lại). */
async function sessionExpired(): Promise<boolean> {
  try {
    const res = await fetch(PROBE_URL, { method: "GET", cache: "no-store", credentials: "same-origin" });
    return res.status === 401;
  } catch {
    return false;
  }
}

// Một EventSource duy nhất cho cả trang, đếm tham chiếu theo số component đang dùng.
let source: EventSource | null = null;
let refs = 0;
let state: ConnectionState = "connecting";
let everOpened = false;
let reopenTimer: ReturnType<typeof setTimeout> | null = null;
const stateListeners = new Set<() => void>();
const eventListeners = new Set<(e: DocumentEvent) => void>();

function subscribeState(l: () => void) {
  stateListeners.add(l);
  return () => {
    stateListeners.delete(l);
  };
}

function setState(next: ConnectionState) {
  if (state === next) return;
  state = next;
  for (const l of [...stateListeners]) l();
}

function notifyChanged(detail: DocumentEvent | null) {
  window.dispatchEvent(new CustomEvent(DOCUMENTS_CHANGED_EVENT, { detail }));
}

function isEvent(v: unknown): v is DocumentEvent {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return e.type === "document.status" && typeof e.documentId === "string" && typeof e.filename === "string" && typeof e.status === "string";
}

function open() {
  if (source || typeof EventSource === "undefined") return;
  const es = new EventSource(EVENTS_URL);
  source = es;
  es.onopen = () => {
    const wasReconnect = everOpened;
    everOpened = true;
    setState("open");
    if (wasReconnect) notifyChanged(null); // bù các sự kiện đã lỡ trong lúc mất kết nối
  };
  es.addEventListener("document", (m) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse((m as MessageEvent<string>).data);
    } catch {
      return;
    }
    if (!isEvent(parsed)) return;
    for (const l of [...eventListeners]) {
      try {
        l(parsed);
      } catch {
        /* listener lỗi không làm hỏng luồng */
      }
    }
    notifyChanged(parsed);
  });
  // Server vừa LISTEN lại sau khi mất kết nối: có thể đã lỡ sự kiện, chỉ tải lại (không toast/chuông).
  es.addEventListener("resync", () => notifyChanged(null));
  es.onerror = () => {
    setState("reconnecting");
    // Trình duyệt tự kết nối lại; nếu nó bỏ cuộc (CLOSED, ví dụ 401/503) thì mở lại sau một lúc.
    if (es.readyState === 2 && source === es) {
      es.close();
      source = null;
      void sessionExpired().then((expired) => {
        if (expired) {
          navigation.toLogin(); // đăng nhập lại; không tiếp tục thử mở luồng với phiên chết
          return;
        }
        if (refs === 0 || source || reopenTimer) return;
        reopenTimer = setTimeout(() => {
          reopenTimer = null;
          if (refs > 0) open();
        }, REOPEN_MS);
      });
    }
  };
}

function acquire() {
  refs++;
  if (refs === 1) open();
}

function release() {
  refs = Math.max(0, refs - 1);
  if (refs > 0) return;
  if (reopenTimer) clearTimeout(reopenTimer);
  reopenTimer = null;
  source?.close();
  source = null;
  everOpened = false;
  state = "connecting";
}

/**
 * Dùng chung một kết nối SSE. `onEvent` (nếu có) nhận từng sự kiện; mỗi sự kiện còn phát
 * `window` CustomEvent "documents:changed" để các thành phần khác (bảng văn bản) tải lại.
 */
export function useDocumentEvents(onEvent?: (e: DocumentEvent) => void): { connection: ConnectionState } {
  const connection = useSyncExternalStore(
    subscribeState,
    () => state,
    () => "connecting" as ConnectionState,
  );
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });

  useEffect(() => {
    const onMsg = (e: DocumentEvent) => handler.current?.(e);
    eventListeners.add(onMsg);
    acquire();
    return () => {
      eventListeners.delete(onMsg);
      release();
    };
  }, []);

  return { connection };
}
