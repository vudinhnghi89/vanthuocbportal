import Link from "next/link";
import { NotificationBell } from "./NotificationBell";

export function UserHeader({
  username,
  role,
  signOutAction,
}: {
  username: string;
  role: "admin" | "user";
  signOutAction: () => Promise<void>;
}) {
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link href="/" className="brand">
          Văn thư
        </Link>
        <nav aria-label="Tài khoản" className="site-header__nav">
          {role === "admin" && <Link href="/admin/units">Quản trị</Link>}
          <NotificationBell />
          <span className="username">{username}</span>
          <form action={signOutAction}>
            <button type="submit">Đăng xuất</button>
          </form>
        </nav>
      </div>
    </header>
  );
}
