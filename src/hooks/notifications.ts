"use client";

import { useSyncExternalStore } from "react";
import type { DocumentEvent } from "./useDocumentEvents";

export const MAX_NOTIFICATIONS = 30;

export type AppNotification = { id: number; text: string; at: string; read: boolean };
type Snapshot = { items: readonly AppNotification[]; unread: number };

/** Nội dung thông báo cho một sự kiện, hoặc null nếu trạng thái đó không cần thông báo. */
export function notificationText(e: DocumentEvent): string | null {
  if (e.status === "classified") {
    // needsManual=true: còn chờ người phân loại. match_method='none' giữ nguyên sau khi phân loại thủ công.
    if (e.needsManual) {
      return `Văn bản "${e.filename}" chưa khớp rule → chuyển Ban thư ký để phân loại thủ công`;
    }
    const units = `Đơn vị xử lý chính: ${e.mainUnit?.name ?? "—"}; Đơn vị nhận thông tin: ${e.infoUnit?.name ?? "—"}`;
    // classified -> classified: phân loại thủ công vừa hoàn tất.
    if (e.from === "classified") return `Văn bản "${e.filename}" đã được Ban thư ký phân loại — ${units}`;
    return `Văn bản "${e.filename}" đã phân loại — ${units}`;
  }
  if (e.status === "failed") return `Văn bản "${e.filename}" xử lý lỗi`;
  return null;
}

const EMPTY: Snapshot = { items: [], unread: 0 };
let snapshot: Snapshot = EMPTY;
let nextId = 1;
const listeners = new Set<() => void>();

function set(items: readonly AppNotification[]) {
  snapshot = { items, unread: items.filter((n) => !n.read).length };
  for (const l of [...listeners]) l();
}

export function addNotification(text: string, at: string): AppNotification {
  const n = { id: nextId++, text, at, read: false };
  set([n, ...snapshot.items].slice(0, MAX_NOTIFICATIONS));
  return n;
}
export function markAllRead() {
  if (snapshot.unread === 0) return;
  set(snapshot.items.map((n) => (n.read ? n : { ...n, read: true })));
}
export function clearNotifications() {
  if (snapshot.items.length === 0) return;
  set([]);
}
/** Chỉ dùng trong test. */
export function resetNotifications() {
  nextId = 1;
  snapshot = EMPTY;
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useNotifications(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}
