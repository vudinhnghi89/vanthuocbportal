"use client";

import { useEffect, useId, useRef, useState } from "react";
import { clearNotifications, markAllRead, useNotifications } from "@/hooks/notifications";

const time = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const formatAt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : time.format(d);
};

export function NotificationBell() {
  const { items, unread } = useNotifications();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Đang mở thì mọi thông báo mới coi như đã đọc.
  useEffect(() => {
    if (open && unread > 0) markAllRead();
  }, [open, unread]);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (root.current && !root.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div
      className="bell"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={button}
        className="bell__button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={unread > 0 ? `Thông báo, ${unread} chưa đọc` : "Thông báo"}
        onClick={() => setOpen((o) => !o)}
      >
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="bell__count" data-testid="bell-count" aria-hidden="true">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} className="bell__panel" role="region" aria-label="Danh sách thông báo">
          <div className="bell__head">
            <strong>Thông báo</strong>
            <button type="button" onClick={clearNotifications} disabled={items.length === 0}>
              Xóa
            </button>
          </div>
          {items.length === 0 ? (
            <p className="muted">Chưa có thông báo</p>
          ) : (
            <ul>
              {items.map((n) => (
                <li key={n.id}>
                  <span>{n.text}</span> <time className="muted">{formatAt(n.at)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
