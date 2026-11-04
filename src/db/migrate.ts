import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

(async () => {
  const db = createDb(process.env.DATABASE_URL ?? "");
  try {
    await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    console.log("migrate OK");
  } finally {
    await db.pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
