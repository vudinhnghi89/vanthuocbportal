import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { db } from "@/db/client";
import { documents, units } from "@/db/schema";
import { STATUSES, type Status } from "@/lib/status";
import { DOC_EVENTS_CHANNEL } from "./status";

type UnitRef = { id: number; name: string };
type MatchMethod = "single" | "agent" | "none";

/** Sự kiện gửi tới trình duyệt. Không chứa đường dẫn tệp, nội dung trích xuất hay thông tin người tải lên. */
export type DocumentEvent = {
  type: "document.status";
  documentId: string;
  filename: string;
  from: Status;
  status: Status;
  needsManual: boolean;
  matchMethod: MatchMethod | null;
  mainUnit: UnitRef | null;
  infoUnit: UnitRef | null;
  at: string;
};

/** Báo client tải lại: LISTEN vừa được thiết lập lại sau khi mất kết nối nên có thể đã lỡ sự kiện. */
export type ResyncEvent = { type: "resync"; at: string };
export type ServerEvent = DocumentEvent | ResyncEvent;
export type Listener = (e: ServerEvent) => void;

export type LoadedDocument = Pick<DocumentEvent, "filename" | "needsManual" | "matchMethod" | "mainUnit" | "infoUnit">;
export type LoadDocument = (documentId: string) => Promise<LoadedDocument | null>;

export type EventsConfig = {
  connectionString?: string;
  loadDocument?: LoadDocument;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  maxSubscribers?: number;
  /** Thời hạn truy vấn bổ sung dữ liệu cho một sự kiện (mặc định 10 giây). */
  loadTimeoutMs?: number;
};

export const LOAD_TIMEOUT_MS = 10_000;

/** Cấu hình kết nối LISTEN: keepAlive để phát hiện kết nối chết (NAT/firewall cắt kết nối rảnh). */
export function listenClientConfig(connectionString: string | undefined) {
  return { connectionString, keepAlive: true };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("load timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export const MAX_SUBSCRIBERS = 200;

export class TooManySubscribersError extends Error {
  constructor() {
    super("Quá nhiều kết nối thời gian thực");
    this.name = "TooManySubscribersError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function defaultLoadDocument(documentId: string): Promise<LoadedDocument | null> {
  const main = alias(units, "main_unit");
  const info = alias(units, "info_unit");
  const [row] = await db
    .select({
      filename: documents.filename,
      needsManual: documents.needsManual,
      matchMethod: documents.matchMethod,
      mainId: main.id,
      mainName: main.name,
      infoId: info.id,
      infoName: info.name,
    })
    .from(documents)
    .leftJoin(main, eq(main.id, documents.mainUnitId))
    .leftJoin(info, eq(info.id, documents.infoUnitId))
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!row) return null;
  return {
    filename: row.filename,
    needsManual: row.needsManual,
    matchMethod: row.matchMethod,
    mainUnit: row.mainId !== null && row.mainName !== null ? { id: row.mainId, name: row.mainName } : null,
    infoUnit: row.infoId !== null && row.infoName !== null ? { id: row.infoId, name: row.infoName } : null,
  };
}

// Trạng thái dùng chung trong một process web.
let config: EventsConfig = {};
const listeners = new Set<Listener>();
let hasListened = false;
let client: Client | null = null;
let running = false;
let generation = 0;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<void> = Promise.resolve();

/** Chỉ dùng trong test: ghi đè cấu hình (gọi khi chưa có subscriber). `stopEvents()` đặt lại mặc định. */
export function configureEvents(c: EventsConfig): void {
  config = { ...config, ...c };
}

export function subscriberCount(): number {
  return listeners.size;
}

function parsePayload(raw: string | undefined): { documentId: string; from: Status; to: Status } | null {
  if (!raw) return null;
  try {
    const p: unknown = JSON.parse(raw);
    if (typeof p !== "object" || p === null) return null;
    const { documentId, from, to } = p as Record<string, unknown>;
    if (typeof documentId !== "string" || !UUID_RE.test(documentId)) return null;
    if (!STATUSES.includes(from as Status) || !STATUSES.includes(to as Status)) return null;
    return { documentId, from: from as Status, to: to as Status };
  } catch {
    return null;
  }
}

async function handleNotification(raw: string | undefined): Promise<void> {
  const p = parsePayload(raw);
  if (!p) return;
  let doc: LoadedDocument | null;
  try {
    // Truy vấn treo không được chặn hàng đợi tuần tự các thông báo phía sau.
    doc = await withTimeout((config.loadDocument ?? defaultLoadDocument)(p.documentId), config.loadTimeoutMs ?? LOAD_TIMEOUT_MS);
  } catch {
    console.error("[events] không tải được văn bản để phát sự kiện");
    return;
  }
  if (!doc) return;
  const event: DocumentEvent = {
    type: "document.status",
    documentId: p.documentId,
    filename: doc.filename,
    from: p.from,
    status: p.to,
    needsManual: doc.needsManual,
    matchMethod: doc.matchMethod,
    mainUnit: doc.mainUnit,
    infoUnit: doc.infoUnit,
    at: new Date().toISOString(),
  };
  broadcast(event);
}

function broadcast(event: ServerEvent): void {
  for (const l of [...listeners]) {
    try {
      l(event);
    } catch {
      /* một listener lỗi không được làm hỏng các listener khác */
    }
  }
}

function scheduleReconnect(): void {
  if (!running || retryTimer) return;
  const min = config.backoffMinMs ?? 1000;
  const max = config.backoffMaxMs ?? 30_000;
  const base = Math.min(max, min * 2 ** attempt);
  attempt++;
  const delay = base * (0.5 + Math.random() * 0.5);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, delay);
  retryTimer.unref?.();
}

async function connect(): Promise<void> {
  if (!running) return;
  const gen = generation;
  const c = new Client(listenClientConfig(config.connectionString ?? process.env.DATABASE_URL));
  let handled = false;
  const lost = () => {
    if (handled) return;
    handled = true;
    if (client === c) client = null;
    c.end().catch(() => {});
    if (gen === generation) scheduleReconnect();
  };
  c.on("error", lost);
  c.on("end", lost);
  c.on("notification", (m) => {
    if (m.channel !== DOC_EVENTS_CHANNEL) return;
    queue = queue.then(() => handleNotification(m.payload)).catch(() => {});
  });
  client = c;
  try {
    await c.connect();
    await c.query(`LISTEN ${DOC_EVENTS_CHANNEL}`);
    if (gen !== generation) {
      c.end().catch(() => {});
      return;
    }
    attempt = 0;
    // Sau khi LISTEN lại thành công, các NOTIFY trong lúc mất kết nối đã mất: yêu cầu client tải lại.
    if (hasListened) broadcast({ type: "resync", at: new Date().toISOString() });
    hasListened = true;
  } catch {
    lost();
  }
}

function startListening(): void {
  if (running) return;
  running = true;
  generation++;
  attempt = 0;
  void connect();
}

function stopListening(): void {
  running = false;
  hasListened = false;
  generation++;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const c = client;
  client = null;
  c?.on("error", () => {});
  c?.end().catch(() => {});
}

/** Đăng ký nhận sự kiện; kết nối LISTEN được mở khi có subscriber đầu tiên và đóng khi subscriber cuối rời đi. */
export function subscribe(listener: Listener): () => void {
  if (listeners.size >= (config.maxSubscribers ?? MAX_SUBSCRIBERS)) throw new TooManySubscribersError();
  // Bọc để cùng một hàm đăng ký hai lần vẫn là hai subscriber độc lập.
  const entry: Listener = (e) => listener(e);
  listeners.add(entry);
  startListening();
  return () => {
    if (!listeners.delete(entry)) return;
    if (listeners.size === 0) stopListening();
  };
}

/** Dừng hẳn (test/tắt máy): bỏ subscriber, đóng kết nối, đặt lại cấu hình. */
export async function stopEvents(): Promise<void> {
  listeners.clear();
  stopListening();
  config = {};
  await queue.catch(() => {});
  queue = Promise.resolve();
}
