export type DbSuiteMode = "run" | "skip" | "fail";

/** DATABASE_URL thiếu: skip khi chạy local, nhưng fail khi chạy trong CI. */
export function dbSuiteMode(env: Record<string, string | undefined>): DbSuiteMode {
  if (env.DATABASE_URL) return "run";
  return env.CI ? "fail" : "skip";
}
