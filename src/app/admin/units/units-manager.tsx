"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Unit } from "@/server/units";

export function UnitsManager({ units }: { units: Unit[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);

  async function call(url: string, method: string, body: unknown): Promise<boolean> {
    setError(null);
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Thao tác thất bại");
      return false;
    }
    router.refresh();
    return true;
  }

  return (
    <div>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call("/api/admin/units", "POST", { name: newName })) setNewName("");
        }}
      >
        <label>
          Tên đơn vị mới <input value={newName} onChange={(e) => setNewName(e.target.value)} required />
        </label>
        <button type="submit">Thêm đơn vị</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Tên đơn vị</th>
            <th>Trạng thái</th>
            <th>Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {units.map((u) => (
            <tr key={u.id}>
              <td>
                {editing?.id === u.id ? (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (await call(`/api/admin/units/${u.id}`, "PATCH", { name: editing.name })) setEditing(null);
                    }}
                  >
                    <input
                      aria-label={`Tên mới của ${u.name}`}
                      value={editing.name}
                      onChange={(e) => setEditing({ id: u.id, name: e.target.value })}
                      required
                    />
                    <button type="submit">Lưu</button>
                    <button type="button" onClick={() => setEditing(null)}>
                      Hủy
                    </button>
                  </form>
                ) : (
                  <>
                    {u.name}
                    {u.isSecretariat && " (Ban thư ký)"}
                  </>
                )}
              </td>
              <td>{u.active ? "Đang hoạt động" : "Đã tắt"}</td>
              <td>
                <button type="button" onClick={() => setEditing({ id: u.id, name: u.name })}>
                  Đổi tên
                </button>{" "}
                <button
                  type="button"
                  disabled={u.isSecretariat}
                  title={u.isSecretariat ? "Không thể tắt Ban thư ký" : undefined}
                  onClick={() => call(`/api/admin/units/${u.id}`, "PATCH", { active: !u.active })}
                >
                  {u.active ? "Tắt" : "Bật"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
