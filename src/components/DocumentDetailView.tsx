"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { STATUS_LABELS, type Status } from "@/lib/status";
import type { DocumentDetail } from "@/server/document-detail";

type UnitOption = { id: number; name: string };

const MATCH_TEXT = { single: "Khớp 1 rule", agent: "AI chọn rule", none: "Không khớp rule nào" } as const;
const dateTime = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const formatTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : dateTime.format(d);
};
const label = (s: Status | null) => (s === null ? "—" : (STATUS_LABELS[s] ?? s));

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    /* không phải JSON */
  }
  return fallback;
}

const TABS = [
  { key: "md", label: "Nội dung (Markdown)" },
  { key: "json", label: "Dữ liệu trích xuất (JSON)" },
  { key: "history", label: "Lịch sử trạng thái" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function DocumentDetailView({ detail, isAdmin }: { detail: DocumentDetail; isAdmin: boolean }) {
  const router = useRouter();
  const uid = useId();
  const [tab, setTab] = useState<TabKey>("md");
  const [notice, setNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const canClassify = detail.needsManual && detail.status === "classified";
  const wasManual = detail.needsManual || detail.matchMethod === "none";

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await fetch(`/api/documents/${detail.id}/retry`, { method: "POST" });
      if (res.ok) {
        setNotice("Đã đưa văn bản vào hàng đợi chạy lại");
        router.refresh();
      } else {
        setRetryError(await errorMessage(res, "Không thể chạy lại văn bản"));
      }
    } catch {
      setRetryError("Không thể kết nối máy chủ, vui lòng thử lại");
    } finally {
      setRetrying(false);
    }
  }

  const json = detail.extracted === null || detail.extracted === undefined ? "" : JSON.stringify(detail.extracted, null, 2);

  return (
    <div className="doc-detail">
      <p>
        <Link href="/">← Danh sách văn bản</Link>
      </p>
      <h1>{detail.filename}</h1>
      <dl className="doc-meta">
        <dt>Trạng thái</dt>
        <dd>
          <span className={`badge badge--${detail.status}`}>{STATUS_LABELS[detail.status] ?? detail.status}</span>
          {detail.needsManual && <span className="badge badge--manual">Cần phân loại thủ công</span>}
        </dd>
        <dt>Đơn vị xử lý chính</dt>
        <dd>{detail.mainUnit?.name ?? "—"}</dd>
        <dt>Đơn vị nhận thông tin</dt>
        <dd>{detail.infoUnit?.name ?? "—"}</dd>
        <dt>Cách phân loại</dt>
        <dd>{detail.matchMethod ? MATCH_TEXT[detail.matchMethod] : "—"}</dd>
        <dt>Người tải lên</dt>
        <dd>{detail.uploadedBy ?? "—"}</dd>
        <dt>Cập nhật lúc</dt>
        <dd>{formatTime(detail.updatedAt)}</dd>
      </dl>
      {detail.hasPdf ? (
        <p>
          <a href={`/api/documents/${detail.id}/file`} target="_blank" rel="noopener">
            Xem file PDF gốc
          </a>
        </p>
      ) : (
        <p className="muted">Không còn file PDF gốc</p>
      )}

      {notice && (
        <p role="status" aria-live="polite" className="doc-notice">
          {notice}
        </p>
      )}

      {detail.status === "failed" && (
        <div role="alert" className="doc-error">
          <p>{detail.error || "Xử lý văn bản thất bại"}</p>
          {retryError && <p>{retryError}</p>}
          <button type="button" disabled={retrying} onClick={() => void retry()}>
            Chạy lại
          </button>
        </div>
      )}

      {canClassify && <ClassifyForm detail={detail} onDone={(msg) => setNotice(msg)} />}

      <RuleFromDocument detail={detail} isAdmin={isAdmin} wasManual={wasManual} />

      <div role="tablist" aria-label="Thông tin văn bản">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`${uid}-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`${uid}-panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => {
              const i = TABS.findIndex((x) => x.key === tab);
              if (e.key === "ArrowRight") setTab(TABS[(i + 1) % TABS.length].key);
              else if (e.key === "ArrowLeft") setTab(TABS[(i + TABS.length - 1) % TABS.length].key);
              else return;
              e.preventDefault();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${uid}-panel-${tab}`} aria-labelledby={`${uid}-tab-${tab}`} tabIndex={0}>
        {tab === "md" && (
          <>
            {detail.markdownTruncated && <p className="muted">Nội dung đã cắt bớt (chỉ hiển thị phần đầu).</p>}
            {detail.markdown ? <pre className="doc-pre">{detail.markdown}</pre> : <p className="muted">Chưa có nội dung.</p>}
          </>
        )}
        {tab === "json" &&
          (json ? <pre className="doc-pre">{json}</pre> : <p className="muted">Chưa có dữ liệu trích xuất.</p>)}
        {tab === "history" && (
          <table className="doc-table">
            <caption className="visually-hidden">Lịch sử trạng thái</caption>
            <thead>
              <tr>
                <th scope="col">Thời gian</th>
                <th scope="col">Từ</th>
                <th scope="col">Đến</th>
                <th scope="col">Người thực hiện</th>
                <th scope="col">Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {detail.events.length === 0 && (
                <tr>
                  <td colSpan={5}>Chưa có lịch sử</td>
                </tr>
              )}
              {detail.events.map((e, i) => (
                <tr key={i}>
                  <td>{formatTime(e.at)}</td>
                  <td>{label(e.from)}</td>
                  <td>{label(e.to)}</td>
                  <td>{e.actor ?? "Hệ thống"}</td>
                  <td>{e.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RuleFromDocument({ detail, isAdmin, wasManual }: { detail: DocumentDetail; isAdmin: boolean; wasManual: boolean }) {
  if (!wasManual) return null;
  if (isAdmin) {
    return (
      <p>
        <Link href={`/admin/rules?fromDocument=${detail.id}`}>Tạo rule từ văn bản này</Link>
      </p>
    );
  }
  return <p className="muted">Liên hệ quản trị viên để thêm rule cho loại văn bản này.</p>;
}

function ClassifyForm({ detail, onDone }: { detail: DocumentDetail; onDone: (msg: string) => void }) {
  const router = useRouter();
  const uid = useId();
  const [units, setUnits] = useState<UnitOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [main, setMain] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/units", { signal: ctl.signal });
        if (!res.ok) throw new Error(await errorMessage(res, "Không tải được danh sách đơn vị"));
        const body = await res.json();
        if (Array.isArray(body)) setUnits(body as UnitOption[]);
        else throw new Error("Không tải được danh sách đơn vị");
      } catch (e) {
        if (ctl.signal.aborted) return;
        setLoadError(e instanceof Error && !(e instanceof TypeError) ? e.message : "Không tải được danh sách đơn vị");
      }
    })();
    return () => ctl.abort();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !main) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${detail.id}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mainUnitId: Number(main), infoUnitId: info === "" ? null : Number(info) }),
      });
      if (res.ok) {
        onDone("Đã lưu phân loại thủ công");
        router.refresh();
      } else {
        setError(await errorMessage(res, "Không thể lưu phân loại"));
      }
    } catch {
      setError("Không thể kết nối máy chủ, vui lòng thử lại");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Phân loại thủ công" className="doc-classify">
      <h2>Phân loại thủ công</h2>
      <p className="muted">Văn bản không khớp rule nào. Chọn đơn vị xử lý để tiếp tục.</p>
      {loadError && <p role="alert">{loadError}</p>}
      <p>
        <label htmlFor={`${uid}-main`}>Đơn vị xử lý chính</label>{" "}
        <select id={`${uid}-main`} value={main} onChange={(e) => setMain(e.target.value)} required disabled={busy}>
          <option value="">-- Chọn đơn vị --</option>
          {(units ?? []).map((u) => (
            <option key={u.id} value={String(u.id)}>
              {u.name}
            </option>
          ))}
        </select>
      </p>
      <p>
        <label htmlFor={`${uid}-info`}>Đơn vị nhận thông tin</label>{" "}
        <select id={`${uid}-info`} value={info} onChange={(e) => setInfo(e.target.value)} disabled={busy}>
          <option value="">Không có</option>
          {(units ?? []).map((u) => (
            <option key={u.id} value={String(u.id)}>
              {u.name}
            </option>
          ))}
        </select>
      </p>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy || !main}>
        Xác nhận phân loại
      </button>
    </form>
  );
}
