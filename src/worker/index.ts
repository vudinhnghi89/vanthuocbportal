import { SHUTDOWN_TIMEOUT_MS } from "./config";
import { handleDeadOcrJob, handleOcrJob } from "./jobs/ocr";
import { startOcrWorker } from "./queue";

async function main() {
  const worker = await startOcrWorker(handleOcrJob, { deadHandler: (documentId) => handleDeadOcrJob(documentId) });
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
