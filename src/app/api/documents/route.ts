import { requireUser, toErrorResponse } from "@/auth/guards";
import { listDocuments, parseListQuery } from "@/server/document-list";
import {
  MAX_FILES,
  MAX_REQUEST_BYTES,
  createDocumentFromUpload,
  hasPdfMagic,
  precheckUpload,
  sanitizeFilename,
  uploadFailure,
  type UploadResult,
} from "@/server/documents";

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireUser();

    const header = req.headers.get("content-length");
    if (header === null || !/^\d+$/.test(header.trim())) {
      return Response.json({ error: "Thiếu hoặc sai Content-Length" }, { status: 411 });
    }
    if (Number(header) > MAX_REQUEST_BYTES) {
      return Response.json({ error: "Yêu cầu quá lớn" }, { status: 413 });
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: "Dữ liệu tải lên không hợp lệ" }, { status: 400 });
    }
    const files = form.getAll("files").filter((v): v is File => typeof v !== "string");
    if (files.length === 0) return Response.json({ error: "Chưa chọn tệp nào" }, { status: 400 });
    if (files.length > MAX_FILES) {
      return Response.json({ error: `Tối đa ${MAX_FILES} tệp mỗi lần tải lên` }, { status: 400 });
    }

    const results: UploadResult[] = [];
    // Tuần tự: tại mỗi thời điểm chỉ giữ buffer của một tệp.
    for (const file of files) {
      const name = sanitizeFilename(file.name);
      const pre = precheckUpload(name, file.size);
      if (pre) {
        results.push(uploadFailure(name, pre));
        continue;
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!hasPdfMagic(buffer)) {
        results.push(uploadFailure(name, "not_pdf"));
        continue;
      }
      results.push(await createDocumentFromUpload({ filename: file.name, buffer, uploadedBy: session.user.id }));
    }

    if (results.some((r) => r.ok)) return Response.json({ results }, { status: 201 });
    const sizeOnly = results.length === 1 && !results[0].ok && results[0].code === "too_large";
    return Response.json({ results }, { status: sizeOnly ? 413 : 400 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

/** Lưu ý: đường dẫn này bị loại khỏi proxy xác thực nên phải tự gọi requireUser. */
export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser();
    const parsed = parseListQuery(new URL(req.url).searchParams);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    return Response.json(await listDocuments(parsed.filters));
  } catch (e) {
    return toErrorResponse(e);
  }
}
