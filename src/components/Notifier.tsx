"use client";

import { useCallback, useEffect, useState } from "react";
import { addNotification, notificationText } from "@/hooks/notifications";
import { useDocumentEvents, type DocumentEvent } from "@/hooks/useDocumentEvents";

export const TOAST_MS = 8000;
export const MAX_TOASTS = 4;

type Toast = { id: number; text: string };

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast.id, onDismiss]);
  return (
    <li className="toast">
      <span>{toast.text}</span>
      <button type="button" className="toast__close" aria-label="Đóng thông báo" onClick={() => onDismiss(toast.id)}>
        ×
      </button>
    </li>
  );
}

/** Nhận sự kiện thời gian thực: hiện toast và ghi vào danh sách thông báo (chuông ở đầu trang). */
export function Notifier() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const onEvent = useCallback((e: DocumentEvent) => {
    const text = notificationText(e);
    if (!text) return;
    const n = addNotification(text, e.at);
    setToasts((t) => [...t, { id: n.id, text }].slice(-MAX_TOASTS));
  }, []);
  useDocumentEvents(onEvent);

  return (
    <div className="toast-region" role="region" aria-label="Thông báo mới" aria-live="polite">
      <ul>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </ul>
    </div>
  );
}
