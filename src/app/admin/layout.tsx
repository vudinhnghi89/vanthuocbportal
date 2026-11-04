import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { HttpError, requireAdmin } from "@/auth/guards";

const NAV = [
  { href: "/admin/units", label: "Đơn vị" },
  { href: "/admin/rules", label: "Quy tắc" },
  { href: "/admin/users", label: "Người dùng" },
  { href: "/admin/integrations", label: "Cấu hình tích hợp" },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof HttpError) redirect(e.status === 401 ? "/login" : "/");
    throw e;
  }
  return (
    <div>
      <nav aria-label="Quản trị">
        <ul>
          {NAV.map((n) => (
            <li key={n.href}>
              <Link href={n.href}>{n.label}</Link>
            </li>
          ))}
        </ul>
      </nav>
      <main>{children}</main>
    </div>
  );
}
