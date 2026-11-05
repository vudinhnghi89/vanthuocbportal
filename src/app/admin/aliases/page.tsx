import { requireAdminPage } from "@/auth/page-guard";
import { listAliases } from "@/server/aliases";
import { AliasesManager } from "./aliases-manager";

export const dynamic = "force-dynamic";

export default async function AliasesPage() {
  await requireAdminPage();
  const aliases = await listAliases();
  return (
    <section>
      <h1>Bí danh cơ quan ban hành</h1>
      <AliasesManager aliases={aliases.map(({ id, alias, canonicalIssuer }) => ({ id, alias, canonicalIssuer }))} />
    </section>
  );
}
