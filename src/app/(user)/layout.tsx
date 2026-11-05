import type { ReactNode } from "react";
import { signOut } from "@/auth/config";
import { requireUserPage } from "@/auth/page-guard";
import { Notifier } from "@/components/Notifier";
import { UserHeader } from "@/components/UserHeader";

export const dynamic = "force-dynamic";

async function signOutAction() {
  "use server";
  await signOut({ redirectTo: "/login" });
}

export default async function UserLayout({ children }: { children: ReactNode }) {
  const { user } = await requireUserPage();
  return (
    <div className="app-user">
      <UserHeader username={user.username} role={user.role} signOutAction={signOutAction} />
      <Notifier />
      <main className="container">{children}</main>
    </div>
  );
}
