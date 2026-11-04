import { listUnits } from "@/server/units";
import { UnitsManager } from "./units-manager";

export const dynamic = "force-dynamic";

export default async function UnitsPage() {
  const units = await listUnits();
  return (
    <section>
      <h1>Quản lý đơn vị</h1>
      <UnitsManager units={units} />
    </section>
  );
}
