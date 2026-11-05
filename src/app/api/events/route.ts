import { HttpError, requireUser, toErrorResponse } from "@/auth/guards";
import { subscribe, TooManySubscribersError, type ServerEvent } from "@/server/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PING_MS = 25_000;
const REVALIDATE_MS = 5 * 60_000;

const HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** Luồng SSE các thay đổi trạng thái văn bản. Không phát lại sự kiện cũ: client tải lại danh sách khi kết nối lại. */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireUser();
  } catch (e) {
    return toErrorResponse(e);
  }

  const enc = new TextEncoder();
  let push: (e: ServerEvent) => void = () => {};
  let unsubscribe: () => void;
  try {
    unsubscribe = subscribe((e) => push(e));
  } catch (e) {
    if (e instanceof TooManySubscribersError) return Response.json({ error: e.message }, { status: 503 });
    throw e;
  }

  let cleanup: () => void = unsubscribe;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let seq = 0;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          close();
        }
      };
      const revalidateMs = Number(process.env.SSE_REVALIDATE_MS) || REVALIDATE_MS;
      const ping = setInterval(() => send(": ping\n\n"), PING_MS);
      const revalidate = setInterval(() => {
        requireUser().catch((e) => {
          if (e instanceof HttpError) close(); // hết phiên / bị khóa; lỗi hạ tầng thì giữ luồng
        });
      }, revalidateMs);
      function close() {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        clearInterval(revalidate);
        request.signal.removeEventListener("abort", close);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* đã đóng */
        }
      }
      cleanup = close;
      push = (e) =>
        send(
          e.type === "resync"
            ? `id: ${++seq}\nevent: resync\ndata: {}\n\n`
            : `id: ${++seq}\nevent: document\ndata: ${JSON.stringify(e)}\n\n`,
        );
      if (request.signal.aborted) return close();
      request.signal.addEventListener("abort", close);
      send("retry: 3000\n\n: connected\n\n");
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: HEADERS });
}
