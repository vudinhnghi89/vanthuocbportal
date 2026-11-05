"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { RuleDraft } from "@/server/rule-draft";
import type { Rule } from "@/server/rules";
import type { Unit } from "@/server/units";

type Form = {
  id: number | null;
  issuer: string;
  docType: string;
  title: string;
  summary: string;
  mainUnitId: string;
  infoUnitId: string;
  priority: string;
};

const emptyForm = (): Form => ({
  id: null,
  issuer: "",
  docType: "",
  title: "",
  summary: "",
  mainUnitId: "",
  infoUnitId: "",
  priority: "0",
});

const draftForm = (units: Unit[], d: RuleDraft): Form => {
  const has = (id: number | null) => id !== null && units.some((u) => u.id === id);
  return {
    ...emptyForm(),
    issuer: d.issuer,
    docType: d.docType,
    title: d.title,
    summary: d.summary,
    mainUnitId: has(d.mainUnitId) ? String(d.mainUnitId) : "",
    infoUnitId: has(d.infoUnitId) ? String(d.infoUnitId) : "",
  };
};

export function RulesManager({
  rules,
  units,
  allUnits,
  q,
  initialDraft = null,
  draftNotice,
}: {
  rules: Rule[];
  units: Unit[];
  allUnits: Unit[];
  q: string;
  initialDraft?: RuleDraft | null;
  draftNotice?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(q);
  const [form, setForm] = useState<Form>(() => (initialDraft ? draftForm(units, initialDraft) : emptyForm()));
  const [savedFromDraft, setSavedFromDraft] = useState(false);
  const [draftActive, setDraftActive] = useState(true);
  const unitName = (id: number | null) => (id === null ? "—" : (allUnits.find((u) => u.id === id)?.name ?? `#${id}`));

  async function call(url: string, method: string, body?: unknown): Promise<boolean> {
    setError(null);
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Thao tác thất bại");
      return false;
    }
    router.refresh();
    return true;
  }

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSavedFromDraft(false);
    if (form.mainUnitId === "") {
      setError("Vui lòng chọn đơn vị chủ trì");
      return;
    }
    const payload = {
      issuer: form.issuer,
      docType: form.docType,
      title: form.title,
      summary: form.summary,
      mainUnitId: Number(form.mainUnitId),
      infoUnitId: form.infoUnitId === "" ? null : Number(form.infoUnitId),
      priority: Number(form.priority),
    };
    const ok =
      form.id === null
        ? await call("/api/admin/rules", "POST", payload)
        : await call(`/api/admin/rules/${form.id}`, "PATCH", payload);
    if (ok) {
      setForm(emptyForm());
      if (initialDraft && draftActive && form.id === null) {
        setSavedFromDraft(true);
        setDraftActive(false);
      }
    }
  }

  return (
    <div>
      {initialDraft && draftActive && (
        <p role="note" className="doc-notice">
          {`Đang tạo rule từ văn bản "${initialDraft.filename}".`}{" "}
          <Link href={`/documents/${initialDraft.documentId}`}>Quay lại văn bản</Link>
        </p>
      )}
      {!initialDraft && draftNotice && <p className="muted">{draftNotice}</p>}
      {savedFromDraft && initialDraft && (
        <p role="status" aria-live="polite">
          Đã lưu quy tắc mới. <Link href={`/documents/${initialDraft.documentId}`}>Quay lại văn bản</Link>
        </p>
      )}
      {error && <p role="alert">{error}</p>}

      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          router.push(search.trim() ? `/admin/rules?q=${encodeURIComponent(search.trim())}` : "/admin/rules");
        }}
      >
        <label>
          Tìm quy tắc <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="submit">Tìm</button>
      </form>

      <form onSubmit={submit} aria-label={form.id === null ? "Thêm quy tắc" : "Sửa quy tắc"}>
        <h2>{form.id === null ? "Thêm quy tắc" : `Sửa quy tắc #${form.id}`}</h2>
        <p>
          <label>
            Cơ quan ban hành <input value={form.issuer} onChange={set("issuer")} required />
          </label>
        </p>
        <p>
          <label>
            Loại văn bản <input value={form.docType} onChange={set("docType")} required />
          </label>
        </p>
        <p>
          <label>
            Tiêu đề <input value={form.title} onChange={set("title")} />
          </label>
        </p>
        <p>
          <label>
            Trích yếu <textarea value={form.summary} onChange={set("summary")} />
          </label>
        </p>
        <p>
          <label>
            Đơn vị chủ trì{" "}
            <select value={form.mainUnitId} onChange={set("mainUnitId")} aria-required="true">
              <option value="">Chọn đơn vị…</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            Đơn vị nhận để biết{" "}
            <select value={form.infoUnitId} onChange={set("infoUnitId")}>
              <option value="">(Không có)</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            Độ ưu tiên <input type="number" step={1} value={form.priority} onChange={set("priority")} required />
          </label>
        </p>
        <button type="submit">{form.id === null ? "Thêm quy tắc" : "Lưu"}</button>
        {form.id !== null && (
          <button type="button" onClick={() => setForm(emptyForm())}>
            Hủy
          </button>
        )}
      </form>

      <table>
        <thead>
          <tr>
            <th>Cơ quan ban hành</th>
            <th>Loại văn bản</th>
            <th>Tiêu đề</th>
            <th>Trích yếu</th>
            <th>Chủ trì</th>
            <th>Nhận để biết</th>
            <th>Ưu tiên</th>
            <th>Trạng thái</th>
            <th>Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {rules.length === 0 && (
            <tr>
              <td colSpan={9}>Không có quy tắc nào</td>
            </tr>
          )}
          {rules.map((r) => (
            <tr key={r.id}>
              <td>{r.issuer}</td>
              <td>{r.docType}</td>
              <td>{r.title}</td>
              <td>{r.summary}</td>
              <td>{unitName(r.mainUnitId)}</td>
              <td>{unitName(r.infoUnitId)}</td>
              <td>{r.priority}</td>
              <td>{r.active ? "Đang bật" : "Đã tắt"}</td>
              <td>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setDraftActive(false);
                    setSavedFromDraft(false);
                    setForm({
                      id: r.id,
                      issuer: r.issuer,
                      docType: r.docType,
                      title: r.title,
                      summary: r.summary,
                      mainUnitId: String(r.mainUnitId),
                      infoUnitId: r.infoUnitId === null ? "" : String(r.infoUnitId),
                      priority: String(r.priority),
                    });
                  }}
                >
                  Sửa
                </button>{" "}
                <button type="button" onClick={() => call(`/api/admin/rules/${r.id}`, "PATCH", { active: !r.active })}>
                  {r.active ? "Tắt" : "Bật"}
                </button>{" "}
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Xóa quy tắc "${r.issuer} – ${r.docType}"?`)) {
                      call(`/api/admin/rules/${r.id}`, "DELETE");
                    }
                  }}
                >
                  Xóa
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
