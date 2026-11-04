import { SHUTDOWN_TIMEOUT_MS } from "./config";
import { startOcrWorker } from "./queue";

async function main() {
  // Placeholder: T-4.1 thay bằng handleOcrJob. Chỉ log id văn bản, không log nội dung.
  const worker = await startOcrWorker(async (documentId) => {
    console.log(`[worker] ocr job for document ${documentId}`);
  });
  console.log("[worker] started");

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal}, stopping`);
    try {
      // Chờ job đang chạy xong trong hạn; quá hạn thì job được giao lại ở lần chạy sau.
      await worker.stop(SHUTDOWN_TIMEOUT_MS);
      process.exit(0);
    } catch (err) {
      console.error("[worker] stop failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
