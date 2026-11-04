import { Pool } from "pg";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "@/db/schema";

/** Tạo database tạm, áp dụng migration; cleanup() xóa database. Cần DATABASE_URL. */
export async function createTestDb() {
  const baseUrl = process.env.DATABASE_URL!;
  const dbName = `vtp_t_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: baseUrl });
  await admin.query(`CREATE DATABASE ${dbName}`);
  const u = new URL(baseUrl);
  u.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: u.toString() });
  // DROP DATABASE ... WITH (FORCE) có thể giết backend rảnh (57P01): bỏ qua sự kiện lỗi của pool.
  pool.on("error", () => {});
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
  return {
    db,
    /** Chuỗi kết nối tới database tạm (cho thành phần cần kết nối riêng, như pg-boss). */
    url: u.toString(),
    async cleanup() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    },
  };
}
