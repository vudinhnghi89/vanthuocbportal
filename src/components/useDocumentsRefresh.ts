"use client";

import { useEffect, useRef } from "react";

export const DOCUMENTS_UPLOADED_EVENT = "documents:uploaded";
export const POLL_INTERVAL_MS = 15_000;

/**
 * Gọi `refresh` khi có sự kiện tải lên và định kỳ khi tab đang hiển thị.
 * Tách riêng để T-6.4 (SSE) thay phần polling này.
 */
export function useDocumentsRefresh(refresh: () => void, intervalMs: number = POLL_INTERVAL_MS): void {
  const ref = useRef(refresh);
  useEffect(() => {
    ref.current = refresh;
  });

  useEffect(() => {
    const call = () => ref.current();
    const visible = () => document.visibilityState !== "hidden";
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => visible() && call(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (visible()) {
        call();
        start();
      } else stop();
    };
    if (visible()) start();
    window.addEventListener(DOCUMENTS_UPLOADED_EVENT, call);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      window.removeEventListener(DOCUMENTS_UPLOADED_EVENT, call);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
}
