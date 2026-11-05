import { requireAdminPage } from "@/auth/page-guard";
import { listUsers } from "@/server/users";
import { UsersManager } from "./users-manager";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  await requireAdminPage();
  const users = await listUsers();
  return (
    <section>
      <h1>Quản lý người dùng</h1>
      <UsersManager users={users.map((u) => ({ id: u.id, username: u.username, role: u.role, active: u.active }))} />
    </section>
  );
}
