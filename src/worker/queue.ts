import { PgBoss } from "pg-boss";

export const OCR_QUEUE = "ocr";

/** Tùy chọn tường minh; mặc định lấy từ môi trường production. Chỉ test mới ghi đè. */
export interface QueueOptions {
  /** Mặc định DATABASE_URL. pg-boss lưu bảng riêng trong schema `pgboss` của cùng database. */
  connectionString?: string;
  /** Tiến trình này có chạy giám sát (hết hạn/giao lại job, dọn dẹp) hay không. Web: false, worker: true. */
  supervise?: boolean;
  /** Thời gian tối đa cho một lần xử lý trước khi job bị coi là treo và giao lại. Mặc định 3600. */
  expireInSeconds?: number;
  retryLimit?: number;
  /** Giây chờ cơ bản giữa các lần thử lại. Mặc định 30 (nhân đôi theo cấp số mũ). */
  retryDelay?: number;
  retryBackoff?: boolean;
  pollingIntervalSeconds?: number;
  superviseIntervalSeconds?: number;
  /** Chu kỳ kiểm tra job hết hạn mỗi hàng đợi (pg-boss mặc định 60s). */
  monitorIntervalSeconds?: number;
}

const DEFAULTS = { expireInSeconds: 3600, retryLimit: 3, retryDelay: 30, retryBackoff: true };

let bossPromise: Promise<PgBoss> | null = null;
let bossSupervises = false;

/**
 * Singleton theo tiến trình, tạo và start lười. Tùy chọn chỉ có tác dụng ở lần tạo đầu tiên.
 * Mặc định không giám sát/lập lịch (tiến trình web); worker bật supervise qua startOcrWorker.
 */
export function getBoss(options: QueueOptions = {}): Promise<PgBoss> {
  if (!bossPromise) {
    const supervise = options.supervise ?? false;
    const connectionString = options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL chưa đặt");
    const boss = new PgBoss({
      connectionString,
      max: supervise ? 5 : 2,
      supervise,
      schedule: false,
      // pg-boss kiểm tra `in config`: chỉ truyền khóa khi có giá trị.
      ...(options.superviseIntervalSeconds !== undefined && {
        superviseIntervalSeconds: options.superviseIntervalSeconds,
      }),
      ...(options.monitorIntervalSeconds !== undefined && {
        monitorIntervalSeconds: options.monitorIntervalSeconds,
      }),
    });
    // Không để lỗi nền của pg-boss làm sập tiến trình; không log nội dung job.
    boss.on("error", (err) => console.error("[queue] pg-boss error:", err.message));
    bossSupervises = supervise;
    const p = (async () => {
      await boss.start();
      await boss.createQueue(OCR_QUEUE, {
        policy: "exclusive", // một job chưa xong (created/retry/active) cho mỗi singletonKey
        retryLimit: DEFAULTS.retryLimit,
        retryDelay: DEFAULTS.retryDelay,
        retryBackoff: DEFAULTS.retryBackoff,
        expireInSeconds: DEFAULTS.expireInSeconds,
      });
      return boss;
    })();
    bossPromise = p;
    p.catch(async () => {
      if (bossPromise === p) bossPromise = null;
      await boss.stop({ graceful: false, timeout: 1000 }).catch(() => {});
    });
  }
  return bossPromise;
}

/** Đẩy job OCR. Trả về id job, hoặc null nếu văn bản này đã có job đang chờ/đang chạy. */
export async function enqueueOcr(documentId: string, options: QueueOptions = {}): Promise<string | null> {
  const boss = await getBoss(options);
  return boss.send(
    OCR_QUEUE,
    { documentId },
    {
      singletonKey: documentId,
      expireInSeconds: options.expireInSeconds ?? DEFAULTS.expireInSeconds,
      retryLimit: options.retryLimit ?? DEFAULTS.retryLimit,
      retryDelay: options.retryDelay ?? DEFAULTS.retryDelay,
      retryBackoff: options.retryBackoff ?? DEFAULTS.retryBackoff,
    },
  );
}

/**
 * Đăng ký worker `ocr`, xử lý tuần tự (mỗi lần một job). Handler throw => job fail và được thử lại.
 * Worker cần giám sát để job treo được giao lại; nếu boss hiện có không giám sát thì tạo lại.
 */
export async function startOcrWorker(
  handler: (documentId: string) => Promise<void>,
  options: QueueOptions = {},
): Promise<{ stop(timeoutMs?: number): Promise<void> }> {
  if (bossPromise && !bossSupervises) await stopBoss();
  const boss = await getBoss({ ...options, supervise: true });
  await boss.work<{ documentId: string }>(
    OCR_QUEUE,
    {
      batchSize: 1,
      localConcurrency: 1,
      ...(options.pollingIntervalSeconds !== undefined && {
        pollingIntervalSeconds: options.pollingIntervalSeconds,
      }),
    },
    async ([job]) => {
      await handler(job.data.documentId);
    },
  );
  return { stop: (timeoutMs) => stopBoss(timeoutMs) };
}

/** Dừng boss: chờ job đang chạy xong trong timeoutMs, quá hạn thì job được đánh dấu fail để giao lại. */
export async function stopBoss(timeoutMs = 30_000): Promise<void> {
  const p = bossPromise;
  bossPromise = null;
  if (!p) return;
  const boss = await p.catch(() => null);
  if (boss) await boss.stop({ graceful: true, timeout: timeoutMs });
}
