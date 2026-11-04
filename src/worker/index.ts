// Placeholder worker: log và giữ tiến trình sống. Hàng đợi pg-boss thêm ở task sau.
console.log("[worker] started");

const keepAlive = setInterval(() => {}, 60_000);

function shutdown(signal: string) {
  console.log(`[worker] ${signal}, stopping`);
  clearInterval(keepAlive);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
