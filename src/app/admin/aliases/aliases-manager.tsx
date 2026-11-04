"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Row = { id: number; alias: string; canonicalIssuer: string };

export function AliasesManager({ aliases }: { aliases: Row[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [alias, setAlias] = useState("");
  const [canonical, setCanonical] = useState("");

  async function call(url: string, method: string, body?: unknown): Promise<boolean> {
    setError(null);
    try {
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
    } catch {
      setError("Không kết nối được máy chủ");
      return false;
    }
  }

  return (
    <div>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call("/api/admin/aliases", "POST", { alias, canonicalIssuer: canonical })) {
            setAlias("");
            setCanonical("");
          }
        }}
      >
        <label>
          Bí danh <input value={alias} onChange={(e) => setAlias(e.target.value)} maxLength={200} required />
        </label>{" "}
        <label>
          Tên cơ quan chuẩn{" "}
          <input value={canonical} onChange={(e) => setCanonical(e.target.value)} maxLength={200} required />
        </label>{" "}
        <button type="submit">Thêm bí danh</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Bí danh</th>
            <th>Tên cơ quan chuẩn</th>
            <th>Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {aliases.map((a) => (
            <tr key={a.id}>
              <td>{a.alias}</td>
              <td>{a.canonicalIssuer}</td>
              <td>
                <button
                  type="button"
                  onClick={async () => {
                    if (window.confirm(`Xóa bí danh "${a.alias}"?`)) await call(`/api/admin/aliases/${a.id}`, "DELETE");
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
