"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent } from "react";
import { describeServerResult, planBatches, type ServerOutcome, validateFile } from "@/lib/upload-plan";

/**
 * Sự kiện cửa sổ phát ra sau mỗi lô tải lên có ít nhất một tệp thành công.
 * Danh sách văn bản (T-6.2) có thể đăng ký để tải lại:
 *   window.addEventListener("documents:uploaded", refresh)
 */
export const DOCUMENTS_UPLOADED_EVENT = "documents:uploaded";

const UPLOAD_URL = "/api/documents";

type RowStatus = "pending" | "uploading" | "queued" | "error";
type Row = { id: number; name: string; status: RowStatus; progress: number; message?: string };
type Item = { id: number; file: File; size: number };

const filesFromDrop = (dt: DataTransfer): File[] => {
  const files = Array.from(dt.files ?? []);
  const items = dt.items ? Array.from(dt.items) : [];
  if (items.length !== files.length) return files;
  // Bỏ qua thư mục được thả vào (webkitGetAsEntry cho biết đó là thư mục).
  return files.filter((_, i) => {
    const entry = items[i].kind === "file" ? items[i].webkitGetAsEntry?.() : null;
    return !entry?.isDirectory;
  });
};

export function Dropzone() {
  const [rows, setRows] = useState<Row[]>([]);
  const [active, setActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const seen = useRef(new WeakSet<File>());
  const chain = useRef<Promise<void>>(Promise.resolve());
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const unmounted = useRef(false);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      xhrRef.current?.abort();
    };
  }, []);

  const patch = useCallback((ids: Set<number>, fn: (r: Row) => Partial<Row>) => {
    if (unmounted.current) return;
    setRows((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, ...fn(r) } : r)));
  }, []);

  const sendBatch = useCallback(
    (batch: Item[]) =>
      new Promise<void>((resolve) => {
        const ids = new Set(batch.map((b) => b.id));
        const total = batch.reduce((s, b) => s + b.size, 0);
        const form = new FormData();
        for (const b of batch) form.append("files", b.file);
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;
        const finish = (outcome: ServerOutcome) => {
          xhrRef.current = null;
          const out = describeServerResult(batch.map((b) => ({ name: b.file.name })), outcome);
          const byId = new Map(batch.map((b, i) => [b.id, out[i]]));
          patch(ids, (r) => {
            const o = byId.get(r.id)!;
            return o.ok
              ? { status: "queued", progress: 100, message: undefined }
              : { status: "error", message: o.message };
          });
          if (!unmounted.current && out.some((o) => o.ok)) {
            window.dispatchEvent(new CustomEvent(DOCUMENTS_UPLOADED_EVENT));
          }
          resolve();
        };
        xhr.open("POST", UPLOAD_URL);
        patch(ids, () => ({ status: "uploading", progress: 0 }));
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable || e.total === 0) return;
          const sent = Math.min(1, e.loaded / e.total) * total;
          let offset = 0;
          const pct = new Map<number, number>();
          for (const b of batch) {
            const frac = (sent - offset) / Math.max(b.size, 1);
            pct.set(b.id, Math.round(Math.min(1, Math.max(0, frac)) * 100));
            offset += b.size;
          }
          patch(ids, (r) => ({ progress: pct.get(r.id) ?? 0 }));
        };
        xhr.onload = () => {
          let body: unknown = null;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            /* phản hồi không phải JSON */
          }
          finish({ kind: "http", status: xhr.status, body });
        };
        xhr.onerror = () => finish({ kind: "network" });
        xhr.ontimeout = () => finish({ kind: "network" });
        xhr.onabort = () => {
          xhrRef.current = null;
          resolve();
        };
        xhr.send(form);
      }),
    [patch],
  );

  const handleFiles = useCallback(
    (incoming: File[]) => {
      const fresh = incoming.filter((f) => !seen.current.has(f));
      for (const f of fresh) seen.current.add(f);
      if (fresh.length === 0) return;
      const newRows: Row[] = [];
      const valid: Item[] = [];
      for (const file of fresh) {
        const id = nextId.current++;
        const v = validateFile(file);
        if (v.ok) {
          valid.push({ id, file, size: file.size });
          newRows.push({ id, name: file.name, status: "pending", progress: 0 });
        } else {
          newRows.push({ id, name: file.name, status: "error", progress: 0, message: v.message });
        }
      }
      setRows((rs) => [...rs, ...newRows]);
      if (valid.length === 0) return;
      // Các lô chạy tuần tự, kể cả khi người dùng chọn thêm tệp lúc đang tải.
      chain.current = chain.current.then(async () => {
        for (const batch of planBatches(valid)) {
          if (unmounted.current) return;
          await sendBatch(batch);
        }
      });
    },
    [sendBatch],
  );

  const openPicker = () => inputRef.current?.click();

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    handleFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setActive(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (hasFiles(e)) setActive(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setActive(false);
    handleFiles(filesFromDrop(e.dataTransfer));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPicker();
    }
  };

  const busy = rows.some((r) => r.status === "pending" || r.status === "uploading");
  const queued = rows.filter((r) => r.status === "queued").length;
  const failed = rows.filter((r) => r.status === "error").length;
  const summary = busy
    ? "Đang tải lên…"
    : rows.length === 0
      ? ""
      : `Đã đưa ${queued} văn bản vào hàng đợi${failed ? `, ${failed} lỗi` : ""}`;

  const label = (r: Row) => {
    switch (r.status) {
      case "pending":
        return "Chờ tải lên";
      case "uploading":
        return `Đang tải lên ${r.progress}%`;
      case "queued":
        return "Đã vào hàng đợi";
      default:
        return `Lỗi: ${r.message ?? "không xác định"}`;
    }
  };

  return (
    <div className="upload">
      <div
        data-testid="dropzone"
        role="group"
        aria-label="Vùng kéo thả tệp PDF"
        tabIndex={0}
        className={`dropzone${active ? " dropzone--active" : ""}`}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onKeyDown={onKeyDown}
      >
        <p>Kéo và thả tệp PDF vào đây, hoặc</p>
        <button type="button" onClick={openPicker}>
          Chọn tệp
        </button>
        <p className="muted">Tối đa 50 MB mỗi tệp. Tệp được đưa vào hàng đợi xử lý ngay sau khi chọn.</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,.pdf"
          aria-label="Chọn tệp PDF"
          className="visually-hidden"
          onChange={onChange}
        />
      </div>
      <div role="status" aria-live="polite" className="upload-summary">
        {summary}
      </div>
      {rows.length > 0 && (
        <>
          <ul data-testid="dropzone-list" className="upload-list">
            {rows.map((r) => (
              <li key={r.id} className={`upload-row upload-row--${r.status}`}>
                <span className="upload-name">{r.name}</span> <span className="upload-state">{label(r)}</span>
                {r.status === "uploading" && <progress max={100} value={r.progress} aria-label={`Tiến trình ${r.name}`} />}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy}
            onClick={() => setRows((rs) => rs.filter((r) => r.status === "pending" || r.status === "uploading"))}
          >
            Xóa danh sách
          </button>
        </>
      )}
    </div>
  );
}
