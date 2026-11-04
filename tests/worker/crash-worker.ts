// Tiến trình con cho tests/worker/queue.test.ts: nhận job rồi treo vĩnh viễn để test SIGKILL nó.
import { startOcrWorker } from "../../src/worker/queue";

const options = JSON.parse(process.env.QUEUE_TEST_OPTIONS ?? "{}");
startOcrWorker(async (documentId) => {
  console.log(`started:${documentId}`);
  await new Promise<never>(() => {});
}, options).then(
  () => console.log("ready"),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
