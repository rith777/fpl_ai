// Run jobs across the machine's cores: each worker is `script` started with
// {...data, jobs: its share}, and posts one message per finished job.
import os from "node:os";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

export async function inParallel(script, data, jobs, onResult) {
  const n = Math.max(1, Math.min(os.cpus().length - 1, jobs.length));
  let done = 0;
  await Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve, reject) => {
    const w = new Worker(fileURLToPath(script), { workerData: { ...data, jobs: jobs.filter((_, j) => j % n === i) } });
    w.on("message", (r) => {
      onResult(r);
      if (++done % 10 === 0 || done === jobs.length) console.log(`   ${done}/${jobs.length} runs`);
    });
    w.on("error", reject);
    w.on("exit", resolve);
  })));
}
