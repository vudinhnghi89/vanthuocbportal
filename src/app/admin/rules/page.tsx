import { listRules } from "@/server/rules";
import { listUnits } from "@/server/units";
import { RulesManager } from "./rules-manager";

export const dynamic = "force-dynamic";

export default async function RulesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const [rules, units] = await Promise.all([listRules({ q }), listUnits()]);
  return (
    <section>
      <h1>Quản lý quy tắc</h1>
      <RulesManager rules={rules} units={units.filter((u) => u.active)} allUnits={units} q={q ?? ""} />
    </section>
  );
}
