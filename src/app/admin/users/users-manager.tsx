"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Row = { id: number; username: string; role: "admin" | "user"; active: boolean };

export function UsersManager({ users }: { users: Row[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", password: "", role: "user" });
  const [resetting, setResetting] = useState<{ id: number; password: string } | null>(null);

  async function call(url: string, method: string, body: unknown): Promise<boolean> {
    setError(null);
    try {
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
    } catch {
      setError("Không thể kết nối tới máy chủ");
      return false;
    }
  }

  return (
    <div>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call("/api/admin/users", "POST", form)) setForm({ username: "", password: "", role: "user" });
        }}
      >
        <label>
          Tên đăng nhập{" "}
          <input
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            required
            minLength={3}
            maxLength={50}
            autoComplete="off"
          />
        </label>{" "}
        <label>
          Mật khẩu{" "}
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
            minLength={8}
            maxLength={256}
            autoComplete="new-password"
          />
        </label>{" "}
        <label>
          Vai trò{" "}
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="user">Người dùng</option>
            <option value="admin">Quản trị viên</option>
          </select>
        </label>{" "}
        <button type="submit">Thêm người dùng</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Tên đăng nhập</th>
            <th>Vai trò</th>
            <th>Trạng thái</th>
            <th>Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>{u.role === "admin" ? "Quản trị viên" : "Người dùng"}</td>
              <td>{u.active ? "Đang hoạt động" : "Đã tắt"}</td>
              <td>
                <button type="button" onClick={() => call(`/api/admin/users/${u.id}`, "PATCH", { active: !u.active })}>
                  {u.active ? "Tắt" : "Bật"}
                </button>{" "}
                {resetting?.id === u.id ? (
                  <form
                    style={{ display: "inline" }}
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (await call(`/api/admin/users/${u.id}`, "PATCH", { password: resetting.password })) {
                        setResetting(null);
                      }
                    }}
                  >
                    <input
                      type="password"
                      aria-label={`Mật khẩu mới của ${u.username}`}
                      value={resetting.password}
                      onChange={(e) => setResetting({ id: u.id, password: e.target.value })}
                      required
                      minLength={8}
                      maxLength={256}
                      autoComplete="new-password"
                    />
                    <button type="submit">Lưu</button>
                    <button type="button" onClick={() => setResetting(null)}>
                      Hủy
                    </button>
                  </form>
                ) : (
                  <button type="button" onClick={() => setResetting({ id: u.id, password: "" })}>
                    Đặt lại mật khẩu
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
