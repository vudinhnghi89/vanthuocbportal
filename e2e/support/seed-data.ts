/**
 * Seeds the E2E database through the project's own server modules (run with tsx, env from global-setup):
 * normal user, units, the rules R1-R4 and the Dify integration settings pointing at the mock.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { createRule } from "@/server/rules";
import { saveDifySettings } from "@/server/settings";
import { createUnit } from "@/server/units";
import { createUser } from "@/server/users";

async function main() {
  const [admin] = await db.select().from(users).where(eq(users.username, process.env.ADMIN_USERNAME ?? "admin"));
  if (!admin) throw new Error("admin missing: run db:seed first");
  await createUser(process.env.E2E_USER_USERNAME!, process.env.E2E_USER_PASSWORD!, "user");

  const planning = await createUnit("Phòng Kế hoạch");
  const finance = await createUnit("Phòng Tài chính");
  const general = await createUnit("Phòng Hành chính");

  const rule = (issuer: string, docType: string, title: string, mainUnitId: number, infoUnitId: number | null, priority = 0) =>
    createRule({ issuer, docType, title, summary: `Quy tắc ${title}`, mainUnitId, infoUnitId, priority }, admin.id);
  await rule("Bộ Tài chính", "Công văn", "Công văn tài chính", finance.id, general.id, 1); // R1
  await rule("Bộ Y tế", "Thông báo", "Thông báo y tế", planning.id, null); // R2
  await rule("Bộ Tài chính", "Thông báo", "Thông báo dự toán", finance.id, planning.id); // R3
  await rule("Bộ Tài chính", "Thông báo", "Thông báo quyết toán", general.id, null); // R4

  const mock = `${process.env.E2E_MOCK_URL}/v1`;
  const common = { baseUrl: mock, apiKey: process.env.E2E_DIFY_API_KEY!, inputVar: "doc", outputVarMd: "text", outputVarJson: "result", timeoutS: 20, retries: 0 };
  await saveDifySettings("dify_ocr", common, admin.id);
  await saveDifySettings("dify_agent", common, admin.id);
}

main()
  .then(() => db.pool.end())
  .then(() => console.log("seed-data OK"))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : "seed-data failed");
    process.exit(1);
  });
