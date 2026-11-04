import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  return Object.assign(drizzle(pool, { schema }), { pool });
}

// Pool kết nối lười: chỉ mở kết nối ở truy vấn đầu tiên.
export const db = createDb(process.env.DATABASE_URL ?? "");
export type Db = typeof db;
