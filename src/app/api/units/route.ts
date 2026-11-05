import { asc, eq } from "drizzle-orm";
import { requireUser, toErrorResponse } from "@/auth/guards";
import { db } from "@/db/client";
import { units } from "@/db/schema";

/** Đơn vị đang hoạt động cho bộ lọc (API quản trị chỉ dành cho admin). */
export async function GET(): Promise<Response> {
  try {
    await requireUser();
    const rows = await db
      .select({ id: units.id, name: units.name, isSecretariat: units.isSecretariat })
      .from(units)
      .where(eq(units.active, true))
      .orderBy(asc(units.name));
    return Response.json(rows);
  } catch (e) {
    return toErrorResponse(e);
  }
}
