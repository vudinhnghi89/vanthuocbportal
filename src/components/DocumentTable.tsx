"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STATUSES, STATUS_LABELS, type Status } from "@/lib/status";
import { useDocumentsRefresh } from "./useDocumentsRefresh";

type UnitRef = { id: number; name: string };
type DocumentListItem = {
  id: string;
  filename: string;
  status: Status;
  error: string | null;
  needsManual: boolean;
  mainUnit: UnitRef | null;
  infoUnit: UnitRef | null;
  updatedAt: string;
};
type ListResponse = { items: DocumentListItem[]; total: number; page: number; pageSize: number };
type UnitOption = { id: number; name: string };

const PAGE_SIZE = 20;
const NOTICE_MS = 6000;
const SEARCH_DEBOUNCE_MS = 300;
const EMPTY_FILTERS = { status: "", unit: "", needsManual: false, from: "", to: "" };
type Filters = typeof EMPTY_FILTERS;

const dateTime = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const formatTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : dateTime.format(d);
};

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    /* không phải JSON */
  }
  return fallback;
}

export function DocumentTable() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  // Kết quả/lỗi gắn với query đã tạo ra chúng; "đang tải" suy ra khi chưa có gì cho query hiện tại.
  const [result, setResult] = useState<{ key: string; data: ListResponse } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const inFlight = useRef(new Set<string>());

  const rangeInvalid = Boolean(filters.from && filters.to && filters.from > filters.to);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.status) p.set("status", filters.status);
    if (filters.unit) p.set("unit", filters.unit);
    if (filters.needsManual) p.set("needsManual", "true");
    if (filters.from) p.set("from", filters.from);
    if (filters.to) p.set("to", filters.to);
    if (q) p.set("q", q);
    p.set("page", String(page));
    p.set("pageSize", String(PAGE_SIZE));
    return p.toString();
  }, [filters, q, page]);

  // Chống phản hồi cũ: mỗi lần tải hủy yêu cầu trước và chỉ yêu cầu mới nhất được ghi kết quả.
  const controller = useRef<AbortController | null>(null);
  const counter = useRef(0);
  const queryRef = useRef(query);
  const qRef = useRef(q);
  const blocked = useRef(rangeInvalid);
  useEffect(() => {
    queryRef.current = query;
    qRef.current = q;
    blocked.current = rangeInvalid;
  });

  const load = useCallback(async () => {
    if (blocked.current) return;
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    const mine = ++counter.current;
    const key = queryRef.current;
    try {
      const res = await fetch(`/api/documents?${key}`, { signal: ctl.signal });
      if (!res.ok) throw new Error(await errorMessage(res, "Không tải được danh sách văn bản"));
      const body = (await res.json()) as ListResponse;
      if (mine !== counter.current) return;
      setResult({ key, data: body });
      setFailure(null);
      const lastPage = Math.max(1, Math.ceil(body.total / body.pageSize));
      if (body.items.length === 0 && body.total > 0 && body.page > lastPage) setPage(lastPage);
    } catch (e) {
      if (ctl.signal.aborted || mine !== counter.current) return;
      const msg = e instanceof TypeError ? "" : e instanceof Error ? e.message : "";
      setFailure({ key, message: msg || "Không tải được danh sách văn bản" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [query, rangeInvalid, load]);

  useEffect(
    () => () => {
      counter.current++;
      controller.current?.abort();
    },
    [],
  );

  const refreshSilently = useCallback(() => void load(), [load]);
  useDocumentsRefresh(refreshSilently);

  // Thông báo tự tắt sau NOTICE_MS; timeout được dọn khi đổi thông báo hoặc unmount.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  // Danh sách đơn vị cho bộ lọc.
  useEffect(() => {
    const ctl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/units", { signal: ctl.signal });
        if (!res.ok) return;
        const body = await res.json();
        if (Array.isArray(body)) setUnits(body as UnitOption[]);
      } catch {
        /* bộ lọc đơn vị để trống */
      }
    })();
    return () => ctl.abort();
  }, []);

  // Tìm kiếm có trì hoãn.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = searchInput.trim();
      if (next === qRef.current) return;
      setQ(next);
      setPage(1);
      setNotice(null);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
    setNotice(null);
  };
  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSearchInput("");
    setQ("");
    setPage(1);
    setNotice(null);
  };
  const hasFilters = Boolean(q || searchInput || JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS));

  const retry = async (id: string) => {
    setRetrying((s) => new Set(s).add(id));
    setNotice(null);
    try {
      const res = await fetch(`/api/documents/${id}/retry`, { method: "POST" });
      if (res.ok) {
        setNotice("Đã đưa văn bản vào hàng đợi chạy lại");
      } else {
        setNotice(await errorMessage(res, "Không thể chạy lại văn bản"));
      }
    } catch {
      setNotice("Không thể kết nối máy chủ, vui lòng thử lại");
    } finally {
      setRetrying((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
    void load();
  };

  const setStatus = async (id: string, from: Status, to: "unit_processing" | "done") => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setRetrying((s) => new Set(s).add(id));
    setNotice(null);
    try {
      const res = await fetch(`/api/documents/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, from }),
      });
      setNotice(res.ok ? "Đã cập nhật" : await errorMessage(res, "Không thể cập nhật trạng thái"));
    } catch {
      setNotice("Không thể kết nối máy chủ, vui lòng thử lại");
    } finally {
      inFlight.current.delete(id);
      setRetrying((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
    void load();
  };

  const data = result?.data ?? null;
  const error = failure && failure.key === query ? failure.message : null;
  // Làm mới nền thất bại: giữ các dòng đã tải của đúng truy vấn này, chỉ hiện biểu ngữ lỗi.
  const hasRows = Boolean(error && result && result.key === query);
  const loading = !rangeInvalid && !error && result?.key !== query;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const items = data?.items ?? [];

  return (
    <div className="doc-list">
      <form className="doc-filters" onSubmit={(e) => e.preventDefault()} aria-label="Bộ lọc văn bản">
        <label>
          Tìm theo tên tệp
          <input type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </label>
        <label>
          Trạng thái
          <select value={filters.status} onChange={(e) => setFilter("status", e.target.value)}>
            <option value="">Tất cả</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Đơn vị
          <select value={filters.unit} onChange={(e) => setFilter("unit", e.target.value)}>
            <option value="">Tất cả</option>
            {units.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Từ ngày
          <input type="date" value={filters.from} onChange={(e) => setFilter("from", e.target.value)} />
        </label>
        <label>
          Đến ngày
          <input type="date" value={filters.to} onChange={(e) => setFilter("to", e.target.value)} />
        </label>
        <label className="doc-filters__check">
          <input
            type="checkbox"
            checked={filters.needsManual}
            onChange={(e) => setFilter("needsManual", e.target.checked)}
          />
          Cần phân loại thủ công
        </label>
        <button type="button" onClick={clearFilters} disabled={!hasFilters}>
          Xóa bộ lọc
        </button>
      </form>
      {rangeInvalid && <p role="alert">Ngày bắt đầu phải trước hoặc bằng ngày kết thúc</p>}

      <p role="status" aria-live="polite" className="muted">
        {data ? `Tổng: ${data.total} văn bản` : ""}
      </p>
      {notice && (
        <p role="status" aria-live="polite" className="doc-notice">
          {notice}
        </p>
      )}

      {error && (
        <div role="alert" className={hasRows ? "doc-warning doc-error" : "doc-error"}>
          <span>{hasRows ? `Không cập nhật được danh sách (đang hiển thị dữ liệu cũ): ${error}` : error}</span>{" "}
          <button
            type="button"
            onClick={() => {
              setFailure(null);
              void load();
            }}
          >
            Thử lại
          </button>
        </div>
      )}

      {!data && loading ? (
        <p className="muted">Đang tải…</p>
      ) : (
        (!error || hasRows) &&
        data &&
        (items.length === 0 ? (
          <p className="muted">{hasFilters ? "Không có văn bản khớp bộ lọc" : "Chưa có văn bản nào"}</p>
        ) : (
          <div className="doc-table-wrap" aria-busy={loading}>
            <table className="doc-table">
              <caption className="visually-hidden">Danh sách văn bản</caption>
              <thead>
                <tr>
                  <th scope="col">Tên văn bản</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Đơn vị xử lý chính</th>
                  <th scope="col">Đơn vị nhận thông tin</th>
                  <th scope="col">Cần phân loại</th>
                  <th scope="col">Cập nhật lúc</th>
                  <th scope="col">Hành động</th>
                </tr>
              </thead>
              <tbody>
                {items.map((d) => (
                  <tr key={d.id}>
                    <th scope="row" className="doc-name">
                      <Link href={`/documents/${d.id}`}>{d.filename}</Link>
                    </th>
                    <td>
                      <span className={`badge badge--${d.status}`}>{STATUS_LABELS[d.status] ?? d.status}</span>
                      {d.status === "failed" && d.error && (
                        <div className="doc-error-text" title={d.error}>
                          {d.error}
                        </div>
                      )}
                    </td>
                    <td>{d.mainUnit?.name ?? ""}</td>
                    <td>{d.infoUnit?.name ?? ""}</td>
                    <td>{d.needsManual && <span className="badge badge--manual">Cần phân loại thủ công</span>}</td>
                    <td>{formatTime(d.updatedAt)}</td>
                    <td>
                      {d.status === "failed" && (
                        <button type="button" disabled={retrying.has(d.id)} onClick={() => void retry(d.id)}>
                          Chạy lại
                        </button>
                      )}
                      {d.status === "classified" && !d.needsManual && (
                        <button
                          type="button"
                          disabled={retrying.has(d.id)}
                          onClick={() => void setStatus(d.id, d.status, "unit_processing")}
                        >
                          Chuyển đơn vị xử lý
                        </button>
                      )}
                      {d.status === "unit_processing" && (
                        <button
                          type="button"
                          disabled={retrying.has(d.id)}
                          onClick={() => void setStatus(d.id, d.status, "done")}
                        >
                          Hoàn tất
                        </button>
                      )}
                      {d.status === "classified" && d.needsManual && (
                        <Link href={`/documents/${d.id}`}>Phân loại</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      <nav className="doc-pager" aria-label="Phân trang">
        <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          Trước
        </button>
        <span>{`Trang ${page}/${totalPages}`}</span>
        <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
          Sau
        </button>
      </nav>
    </div>
  );
}
