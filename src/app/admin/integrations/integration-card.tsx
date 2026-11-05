"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { formatDateTimeVN } from "@/lib/format-time";
import { initialFormValues, type Defaults, type View } from "./form-values";

export function IntegrationCard(props: {
  integrationKey: "dify_ocr" | "dify_agent";
  title: string;
  initial: View;
  defaults: Defaults;
  help: ReactNode;
}) {
  const { integrationKey: key, title, initial, defaults, help } = props;
  const router = useRouter();
  const v = initial;
  const init = initialFormValues(v, defaults);
  const [baseUrl, setBaseUrl] = useState(init.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [inputVar, setInputVar] = useState(init.inputVar);
  const [outputVarMd, setOutputVarMd] = useState(init.outputVarMd);
  const [outputVarJson, setOutputVarJson] = useState(init.outputVarJson);
  const [timeoutS, setTimeoutS] = useState(init.timeoutS);
  const [retries, setRetries] = useState(init.retries);
  const [masked, setMasked] = useState(v.apiKeyMasked);
  const [keyStatus, setKeyStatus] = useState(v.keyStatus);
  const unreadable = keyStatus === "unreadable";
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const id = (n: string) => `${key}-${n}`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/admin/integrations/${key}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl,
          apiKey,
          inputVar,
          outputVarMd,
          outputVarJson,
          timeoutS: Number(timeoutS),
          retries: Number(retries),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({ ok: false, text: data.error ?? "Lưu thất bại" });
        return;
      }
      setApiKey("");
      setMasked(data.apiKeyMasked ?? null);
      setKeyStatus(data.keyStatus ?? "none");
      setStatus({ ok: true, text: "Đã lưu cấu hình" });
      router.refresh();
    } catch {
      setStatus({ ok: false, text: "Không gọi được máy chủ" });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/admin/integrations/${key}/test`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      setStatus({ ok: res.ok && data.ok === true, text: data.message ?? data.error ?? "Kiểm tra thất bại" });
    } catch {
      setStatus({ ok: false, text: "Không gọi được máy chủ" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={id("title")}>
      <h2 id={id("title")}>{title}</h2>
      {help}
      <form onSubmit={save}>
        <p>
          <label htmlFor={id("url")}>Địa chỉ API Dify (ví dụ https://dify.example.com/v1)</label>
          <br />
          <input id={id("url")} type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
        </p>
        <p>
          <label htmlFor={id("key")}>API key</label>
          <br />
          <input
            id={id("key")}
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={masked ? "Để trống để giữ key hiện tại" : "Nhập API key"}
            required={!masked}
          />
          <br />
          <small>Key hiện tại: {unreadable ? "không đọc được" : (masked ?? "chưa có")}</small>
          {unreadable && (
            <>
              <br />
              <small role="alert">
                Không giải mã được API key đã lưu (APP_SECRET có thể đã đổi). Hãy nhập lại API key rồi lưu.
              </small>
            </>
          )}
        </p>
        <p>
          <label htmlFor={id("in")}>Tên biến đầu vào</label>
          <br />
          <input id={id("in")} value={inputVar} onChange={(e) => setInputVar(e.target.value)} required maxLength={100} />
        </p>
        <p>
          <label htmlFor={id("md")}>Tên biến đầu ra markdown</label>
          <br />
          <input id={id("md")} value={outputVarMd} onChange={(e) => setOutputVarMd(e.target.value)} required maxLength={100} />
        </p>
        <p>
          <label htmlFor={id("json")}>Tên biến đầu ra JSON</label>
          <br />
          <input id={id("json")} value={outputVarJson} onChange={(e) => setOutputVarJson(e.target.value)} required maxLength={100} />
        </p>
        <p>
          <label htmlFor={id("timeout")}>Thời gian chờ (giây, 1–600)</label>
          <br />
          <input id={id("timeout")} type="number" min={1} max={600} step={1} value={timeoutS} onChange={(e) => setTimeoutS(e.target.value)} required />
        </p>
        <p>
          <label htmlFor={id("retries")}>Số lần thử lại (0–10)</label>
          <br />
          <input id={id("retries")} type="number" min={0} max={10} step={1} value={retries} onChange={(e) => setRetries(e.target.value)} required />
        </p>
        <p>
          <small>
            Giới hạn: 2 × thời gian chờ × (số lần thử lại + 1) không quá 3300 giây (mỗi lần thử gồm tải tệp lên và chạy
            workflow; công việc hết hạn sau 3600 giây). Mặc định OCR 300 giây × 4 lần = 2400, agent 120 giây × 3 lần = 720.
          </small>
        </p>
        <button type="submit" disabled={busy}>
          Lưu cấu hình
        </button>{" "}
        <button type="button" onClick={test} disabled={busy || (!masked && !unreadable)}>
          Kiểm tra kết nối
        </button>
        {v.updatedAt && (
          <p>
            <small>
              Cập nhật lần cuối: {formatDateTimeVN(v.updatedAt)}
              {v.updatedBy ? ` bởi ${v.updatedBy}` : ""}
            </small>
          </p>
        )}
        {status && <p role={status.ok ? "status" : "alert"}>{status.text}</p>}
      </form>
    </section>
  );
}
