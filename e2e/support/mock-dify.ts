/**
 * Standalone mock of the Dify API used by the E2E suite.
 *   tsx e2e/support/mock-dify.ts --port 4010
 * The OCR result is picked from the original file name embedded in the uploaded PDF's text; the agent workflow picks the candidate rule whose
 * title contains the hint word embedded in the markdown. Control endpoints (not part of Dify):
 *   POST /__control {"fail": ["loi-1.pdf"]}   files whose upload is rejected with HTTP 400 (replaces the set)
 *   GET  /__control                            current state
 */
import http from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: mock-dify.ts --port <n>");
  process.exit(2);
}

type Ocr = { issuer: string; docType: string; title: string; summary: string };

const BY_PREFIX: Record<string, Omit<Ocr, "title" | "summary"> & { name: string }> = {
  ketoan: { name: "kế toán", issuer: "Bộ Tài chính", docType: "Công văn" },
  loi: { name: "lỗi tạm", issuer: "Bộ Tài chính", docType: "Công văn" },
  ycb: { name: "y tế", issuer: "Bộ Y tế", docType: "Thông báo" },
  unknown: { name: "lạ", issuer: "Cục Lạ", docType: "Quyết định" },
  multi: { name: "nhiều rule", issuer: "Bộ Tài chính", docType: "Thông báo" },
};

const state = { fail: new Set<string>(["loi-1.pdf"]) };
const files = new Map<string, string>(); // upload id -> filename
let nextId = 1;

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

function ocrFor(filename: string): { markdown: string; json: Ocr } {
  const m = /^([a-z]+)-([a-z0-9]+?)(?:-\d+)?\.pdf$/i.exec(filename) ?? /^([a-z]+)-(.*)\.pdf$/i.exec(filename);
  const prefix = (m?.[1] ?? "").toLowerCase();
  const hint = fold(m?.[2] ?? "");
  const base = BY_PREFIX[prefix] ?? { name: "không rõ", issuer: "Cơ quan không rõ", docType: "Khác" };
  const json: Ocr = {
    issuer: base.issuer,
    docType: base.docType,
    title: `${base.docType} ${base.name} (${filename})`,
    summary: `Trích yếu của ${filename}`,
  };
  const markdown = `# ${json.docType}\n\n${json.issuer}\n\n${json.summary}\n\n[hint:${/^\d+$/.test(hint) ? "" : hint}]\n`;
  return {
    markdown,
    json: json,
  };
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const run = (outputs: Record<string, unknown>) => ({
  workflow_run_id: "run-e2e",
  task_id: "task-e2e",
  data: { status: "succeeded", outputs, error: null },
});

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    const path = (req.url ?? "").split("?")[0];
    try {
      if (path === "/__control") {
        if (req.method === "POST") {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { fail?: string[] };
          state.fail = new Set(body.fail ?? []);
        }
        return send(res, 200, { fail: [...state.fail] });
      }
      if (req.method === "GET" && path === "/v1/parameters") return send(res, 200, { user_input_form: [] });
      if (req.method === "POST" && path === "/v1/files/upload") {
        const form = await new Response(Buffer.concat(chunks), {
          headers: { "content-type": String(req.headers["content-type"] ?? "") },
        }).formData();
        const file = form.get("file");
        // The portal uploads the stored (UUID-named) file, so the original name is read from the PDF text
        // (e2e/support/pdf.ts embeds it); the multipart filename is the fallback.
        const bytes = file instanceof File ? Buffer.from(await file.arrayBuffer()).toString("latin1") : "";
        const name = /\(([^()]+)\) Tj/.exec(bytes)?.[1] ?? (file instanceof File ? file.name : "");
        if (state.fail.has(name)) return send(res, 400, { code: "invalid_param", message: "mock: rejected file" });
        const id = `file-${nextId++}`;
        files.set(id, name);
        return send(res, 200, { id });
      }
      if (req.method === "POST" && path === "/v1/workflows/run") {
        const { inputs } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { inputs: Record<string, unknown> };
        const doc = inputs.doc;
        if (doc && typeof doc === "object") {
          const name = files.get(String((doc as { upload_file_id?: unknown }).upload_file_id)) ?? "";
          const { markdown, json } = ocrFor(name);
          return send(
            res,
            200,
            run({
              text: markdown,
              result: JSON.stringify({
                co_quan_ban_hanh: json.issuer,
                loai_cong_van: json.docType,
                tieu_de: json.title,
                tom_tat: json.summary,
              }),
            }),
          );
        }
        // Agent: pick the candidate whose (folded) title contains the hint word found in the markdown.
        const hint = /\[hint:([a-z0-9]*)\]/.exec(String(doc ?? ""))?.[1] ?? "";
        const candidates = JSON.parse(String(inputs.candidates ?? "[]")) as { id: number; title: string }[];
        const pick = hint ? candidates.find((c) => fold(c.title).includes(hint)) : undefined;
        return send(res, 200, run({ text: "", result: pick ? String(pick.id) : "" }));
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: e instanceof Error ? e.message : "mock error" });
    }
  });
});

server.listen(port, "127.0.0.1", () => console.log(`[mock-dify] listening on ${port}`));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));
