"use client";

import { useEffect, useRef } from "react";
import { DOCUMENTS_CHANGED_EVENT, useDocumentEvents } from "@/hooks/useDocumentEvents";

export const DOCUMENTS_UPLOADED_EVENT = "documents:uploaded";
export const POLL_INTERVAL_MS = 15_000;
export const REFRESH_DEBOUNCE_MS = 300;

/**
 * Gọi `refresh` (trì hoãn 300 ms) khi có sự kiện SSE hoặc tải lên. Chỉ polling định kỳ khi tab đang
 * hiển thị và kết nối SSE chưa mở (dự phòng).
 */
export function useDocumentsRefresh(refresh: () => void, intervalMs: number = POLL_INTERVAL_MS): void {
  const { connection } = useDocumentEvents();
  const ref = useRef(refresh);
  useEffect(() => {
    ref.current = refresh;
  });

  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        ref.current();
      }, REFRESH_DEBOUNCE_MS);
    };
    window.addEventListener(DOCUMENTS_UPLOADED_EVENT, schedule);
    window.addEventListener(DOCUMENTS_CHANGED_EVENT, schedule);
    return () => {
      if (debounce !== null) clearTimeout(debounce);
      window.removeEventListener(DOCUMENTS_UPLOADED_EVENT, schedule);
      window.removeEventListener(DOCUMENTS_CHANGED_EVENT, schedule);
    };
  }, []);

  const polling = connection !== "open";
  useEffect(() => {
    if (!polling) return;
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
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [polling, intervalMs]);
}
