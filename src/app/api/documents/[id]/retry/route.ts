import { eq } from "drizzle-orm";
import { requireUser, toErrorResponse } from "@/auth/guards";
import { db } from "@/db/client";
import { documents } from "@/db/schema";
import { DocumentNotFoundError, InvalidTransitionError, transition } from "@/server/status";
import { enqueueOcr } from "@/worker/queue";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => Response.json({ error: "Không tìm thấy văn bản" }, { status: 404 });
const notFailed = () => Response.json({ error: "Chỉ có thể chạy lại văn bản đang ở trạng thái lỗi" }, { status: 409 });

/** Chạy lại văn bản `failed`: về `queued` rồi đẩy job OCR. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const session = await requireUser();
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return Response.json({ error: "id không hợp lệ" }, { status: 400 });

    const [doc] = await db.select({ status: documents.status }).from(documents).where(eq(documents.id, id));
    if (!doc) return notFound();
    if (doc.status !== "failed") return notFailed();

    try {
      // Một giao dịch (khóa dòng): xóa lỗi cũ, ghi event; chỉ một yêu cầu đồng thời thắng.
      await transition(id, "queued", { actorId: session.user.id, note: "Chạy lại" });
    } catch (e) {
      if (e instanceof DocumentNotFoundError) return notFound();
      if (e instanceof InvalidTransitionError) return notFailed();
      throw e;
    }

    // Sau khi commit. Nếu enqueue lỗi, văn bản vẫn `queued` và reconciler của worker sẽ đẩy lại.
    let jobId: string | null;
    try {
      jobId = await enqueueOcr(id);
    } catch {
      console.error(`[retry] ${id}: không đẩy được job OCR, reconciler sẽ thử lại`);
      return Response.json({ error: "Hệ thống hàng đợi tạm thời không khả dụng, vui lòng thử lại sau" }, { status: 503 });
    }
    return Response.json({ status: "queued", alreadyQueued: jobId === null });
  } catch (e) {
    return toErrorResponse(e);
  }
}
