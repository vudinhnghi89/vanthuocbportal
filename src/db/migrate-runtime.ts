/**
 * Điểm vào của container `migrate` (bundle dist/migrate.js, xem `npm run build:migrate`):
 * 1) áp dụng migration SQL từ thư mục drizzle/ (MIGRATIONS_DIR, mặc định `<bundle>/../drizzle` = /app/drizzle trong image);
 * 2) chạy seed idempotent (Ban thư ký + admin đầu tiên từ ADMIN_USERNAME/ADMIN_PASSWORD).
 * Chỉ in dòng tiến trình không bí mật. Mã thoát 0/1.
 */
import fs from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";
import { seed } from "./seed";

export function resolveMigrationsDir(env: Record<string, string | undefined>): string {
  const fromEnv = env.MIGRATIONS_DIR?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.resolve(__dirname, "..", "drizzle");
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL chưa đặt");
  const dir = resolveMigrationsDir(process.env);
  if (!fs.existsSync(path.join(dir, "meta", "_journal.json"))) {
    throw new Error(`Không tìm thấy thư mục migration hợp lệ: ${dir} (đặt MIGRATIONS_DIR hoặc COPY drizzle/ vào image)`);
  }
  const db = createDb(url);
  try {
    console.log(`[migrate] áp dụng migration từ ${dir}`);
    await migrate(db, { migrationsFolder: dir });
    console.log("[migrate] migration OK");
    await seed(db, process.env);
    console.log("[migrate] seed OK (Ban thư ký + admin)");
  } finally {
    await db.pool.end();
  }
}

main().catch((e) => {
  console.error(`[migrate] LỖI: ${e instanceof Error ? e.message : "thất bại"}`);
  process.exit(1);
});
