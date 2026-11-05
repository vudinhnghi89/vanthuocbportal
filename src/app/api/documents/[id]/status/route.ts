import { eq } from "drizzle-orm";
import { requireUser, toErrorResponse } from "@/auth/guards";
import { db } from "@/db/client";
import { documents } from "@/db/schema";
import { DOCUMENT_STATUSES, STATUS_LABELS, type Status } from "@/lib/status";
import { DocumentNotFoundError, InvalidTransitionError, transition } from "@/server/status";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Chỉ hai bước thủ công; các trạng thái còn lại do pipeline điều khiển. */
const MANUAL_EDGES: Partial<Record<Status, Status>> = { classified: "unit_processing", unit_processing: "done" };
const MANUAL_TARGETS: readonly Status[] = ["unit_processing", "done"];

const fail = (status: number, error: string) => Response.json({ error }, { status });
const isStatus = (v: unknown): v is Status => typeof v === "string" && (DOCUMENT_STATUSES as readonly string[]).includes(v);

class ConflictError extends Error {}

/** Cập nhật thủ công: classified -> unit_processing -> done. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const session = await requireUser();
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return fail(400, "id không hợp lệ");

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail(400, "Dữ liệu gửi lên không hợp lệ");
    }
    const b = body as { to?: unknown; from?: unknown } | null;
    if (!b || typeof b !== "object" || Array.isArray(b)) return fail(400, "Dữ liệu gửi lên không hợp lệ");
    const to = b.to;
    if (!isStatus(to) || !MANUAL_TARGETS.includes(to)) {
      return fail(400, "Trạng thái đích phải là 'Đơn vị đang xử lý' hoặc 'Xong'");
    }
    if (b.from !== undefined && !isStatus(b.from)) return fail(400, "Trạng thái hiện tại không hợp lệ");
    const expectedFrom = b.from as Status | undefined;

    try {
      // Một giao dịch: khóa dòng, kiểm tra, rồi transition(..., tx) cùng giao dịch.
      const result = await db.transaction(async (tx) => {
        const [doc] = await tx
          .select({ status: documents.status, needsManual: documents.needsManual })
          .from(documents)
          .where(eq(documents.id, id))
          .for("update");
        if (!doc) throw new DocumentNotFoundError(id);
        if (doc.status === to) return { changed: false, status: doc.status };
        if (expectedFrom && expectedFrom !== doc.status) {
          throw new ConflictError("Trạng thái đã thay đổi, vui lòng tải lại");
        }
        if (doc.needsManual) throw new ConflictError("Cần phân loại thủ công trước khi chuyển đơn vị xử lý");
        if (MANUAL_EDGES[doc.status] !== to) throw new InvalidTransitionError(doc.status, to);
        const r = await transition(id, to, { actorId: session.user.id, note: "Cập nhật thủ công" }, tx);
        return { changed: r.changed, status: r.to };
      });
      return Response.json({ id, status: result.status, changed: result.changed });
    } catch (e) {
      if (e instanceof DocumentNotFoundError) return fail(404, "Không tìm thấy văn bản");
      if (e instanceof ConflictError) return fail(409, e.message);
      if (e instanceof InvalidTransitionError) {
        return fail(409, `Không thể chuyển văn bản đang ở trạng thái "${STATUS_LABELS[e.from]}" sang "${STATUS_LABELS[e.to]}"`);
      }
      throw e;
    }
  } catch (e) {
    return toErrorResponse(e);
  }
}
