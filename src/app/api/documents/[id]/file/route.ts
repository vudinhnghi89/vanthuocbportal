import { requireUser, toErrorResponse } from "@/auth/guards";
import { UUID_RE, getDocumentPdf, inlineDisposition, streamFile } from "@/server/document-detail";

const notFound = () => Response.json({ error: "Không tìm thấy tệp" }, { status: 404 });

/** Phát PDF gốc (inline) dạng luồng. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireUser();
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return Response.json({ error: "id không hợp lệ" }, { status: 400 });
    const file = await getDocumentPdf(id);
    if (!file) return notFound();
    return new Response(streamFile(file.path), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(file.size),
        "Content-Disposition": inlineDisposition(file.filename),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        // CSP riêng, chặt hơn CSP toàn app; next.config.ts loại route này khỏi luật CSP chung nên không bị ghi đè.
        // Lưu ý: Chromium có thể để trống trình xem PDF tích hợp khi có `sandbox` -> kiểm tra thủ công
        // (docs/security-checklist.md, "Trình xem PDF inline").
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
