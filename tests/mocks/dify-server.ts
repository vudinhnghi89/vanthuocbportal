import http from "node:http";
import type { AddressInfo } from "node:net";

export type MockReply = { status?: number; body?: unknown; delayMs?: number };

export type RecordedRequest = {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  /** Parsed JSON body (for /workflows/run). */
  json?: unknown;
  /** Parsed multipart form (for /files/upload). */
  form?: FormData;
};

type Handler = (req: RecordedRequest, callNo: number) => MockReply;

export type DifyMock = {
  /** Base URL including the /v1 prefix, no trailing slash. */
  url: string;
  uploads: RecordedRequest[];
  runs: RecordedRequest[];
  /** GET /v1/parameters (connection check). */
  params: RecordedRequest[];
  onUpload: Handler;
  onRun: Handler;
  onParameters: Handler;
  close(): Promise<void>;
};

export async function startDifyMock(): Promise<DifyMock> {
  const mock: DifyMock = {
    url: "",
    uploads: [],
    runs: [],
    params: [],
    onUpload: () => ({ body: { id: "file-1" } }),
    onRun: () => ({ body: { data: { status: "succeeded", outputs: {} } } }),
    onParameters: () => ({ body: { opening_statement: "", user_input_form: [] } }),
    close: async () => {},
  };
  const sockets = new Set<import("node:net").Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const path = (req.url ?? "").split("?")[0];
      const rec: RecordedRequest = { method: req.method ?? "", path, headers: req.headers };
      let handler: Handler | null = null;
      let list: RecordedRequest[] | null = null;
      if (req.method === "POST" && path === "/v1/files/upload") {
        rec.form = await new Response(raw, {
          headers: { "content-type": String(req.headers["content-type"] ?? "") },
        }).formData();
        handler = mock.onUpload;
        list = mock.uploads;
      } else if (req.method === "POST" && path === "/v1/workflows/run") {
        rec.json = JSON.parse(raw.toString("utf8"));
        handler = mock.onRun;
        list = mock.runs;
      } else if (req.method === "GET" && path === "/v1/parameters") {
        handler = mock.onParameters;
        list = mock.params;
      }
      if (!handler || !list) {
        res.writeHead(404).end();
        return;
      }
      list.push(rec);
      const reply = handler(rec, list.length);
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (res.destroyed) return;
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  mock.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return mock;
}

/** Wrap outputs in the Dify blocking workflow response shape. */
export function workflowOk(outputs: Record<string, unknown>): MockReply {
  return {
    body: {
      workflow_run_id: "run-1",
      task_id: "task-1",
      data: { status: "succeeded", outputs, error: null },
    },
  };
}

/**
 * Body text that echoes the received `Authorization: Bearer <key>` header, positioned so the
 * key straddles character `cut` of the body (10 chars of the key before the cut) (to exercise truncation boundaries).
 */
export function echoBearer(req: RecordedRequest, cut = 300): string {
  const auth = String(req.headers.authorization ?? "");
  const keyStart = auth.indexOf(" ") + 1;
  return "x".repeat(Math.max(0, cut - 10 - keyStart)) + auth + " tail";
}
