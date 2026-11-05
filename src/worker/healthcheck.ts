/**
 * Docker healthcheck for the worker: exit 0 when the database answers `select 1`, 1 otherwise.
 * Built to dist/healthcheck.js by `npm run build:healthcheck` and run as `node dist/healthcheck.js`.
 */
import { Client } from "pg";

export async function checkDb(connectionString: string | undefined, timeoutMs = 5000): Promise<boolean> {
  if (!connectionString) return false;
  const client = new Client({ connectionString, connectionTimeoutMillis: timeoutMs });
  client.on("error", () => {});
  try {
    await client.connect();
    const r = await client.query("select 1 as ok");
    return r.rows[0]?.ok === 1;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  void checkDb(process.env.DATABASE_URL).then((ok) => process.exit(ok ? 0 : 1));
}
