import { spawn } from "node:child_process";
import path from "node:path";
import { prisma } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import type { SearchWorkerInput } from "@/lib/pipeline/searchRequest";

interface Worker {
  kill(): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number | null) => void): void;
}
type LaunchWorker = (task: SearchWorkerInput) => Worker;
type EnqueueResult = "started" | "queued" | "hourly_limit" | "queue_full";

const HOUR_MS = 3_600_000;

export class SearchScheduler {
  private readonly queue: SearchWorkerInput[] = [];
  private readonly active = new Map<Worker, SearchWorkerInput>();
  private readonly starts: number[] = [];
  private stopping = false;

  constructor(
    private readonly concurrency: number,
    private readonly queueLimit: number,
    private readonly startsPerHour: number,
    private readonly launchWorker: LaunchWorker,
    private readonly onFinish: (task: SearchWorkerInput, code: number | null, error?: Error) => void = () => {},
  ) {}

  enqueue(task: SearchWorkerInput, now = Date.now()): EnqueueResult {
    if (this.stopping || (this.active.size >= this.concurrency && this.queue.length >= this.queueLimit)) {
      return "queue_full";
    }

    while (this.starts.length && this.starts[0] <= now - HOUR_MS) this.starts.shift();
    if (this.starts.length >= this.startsPerHour) return "hourly_limit";
    this.starts.push(now);

    if (this.active.size < this.concurrency) {
      this.start(task);
      return "started";
    }
    this.queue.push(task);
    return "queued";
  }

  stats() {
    return { activeWorkers: this.active.size, queueDepth: this.queue.length };
  }

  shutdown(): void {
    this.stopping = true;
    while (this.queue.length) {
      this.onFinish(this.queue.shift()!, null, new Error("Search scheduler is shutting down"));
    }
    for (const worker of this.active.keys()) worker.kill();
  }

  private start(task: SearchWorkerInput): void {
    let worker: Worker;
    try {
      worker = this.launchWorker(task);
    } catch (error) {
      this.onFinish(task, null, error instanceof Error ? error : new Error(String(error)));
      this.drain();
      return;
    }

    this.active.set(worker, task);
    let finished = false;
    const finish = (code: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      this.active.delete(worker);
      this.onFinish(task, code, error);
      this.drain();
    };
    worker.onError((error) => finish(null, error));
    worker.onExit((code) => finish(code));
  }

  private drain(): void {
    while (!this.stopping && this.active.size < this.concurrency && this.queue.length) {
      this.start(this.queue.shift()!);
    }
  }
}

const clampInt = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
};

const log = createLogger("search-scheduler");

function spawnSearchWorker(task: SearchWorkerInput): Worker {
  const child = spawn(
    process.execPath,
    [path.join(process.cwd(), ".next", "search-worker.mjs")],
    { stdio: ["pipe", "inherit", "inherit"], env: process.env },
  );
  child.stdin.on("error", (error) => {
    log.warn("Search worker stdin failed", { searchQueryId: task.searchQueryId, error: error.message });
  });
  child.stdin.end(JSON.stringify(task));
  log.info("Search worker started", {
    searchQueryId: task.searchQueryId,
    pid: child.pid,
    parentRssMb: Math.round(process.memoryUsage().rss / 1_048_576),
  });
  return {
    kill: () => { child.kill("SIGTERM"); },
    onError: (listener) => { child.once("error", listener); },
    onExit: (listener) => { child.once("exit", listener); },
  };
}

const globalForScheduler = globalThis as unknown as { searchScheduler?: SearchScheduler };

export function getSearchScheduler(): SearchScheduler {
  if (globalForScheduler.searchScheduler) return globalForScheduler.searchScheduler;

  const scheduler = new SearchScheduler(
    clampInt(process.env.SEARCH_WORKER_CONCURRENCY, 2, 1, 4),
    clampInt(process.env.SEARCH_QUEUE_LIMIT, 10, 0, 100),
    clampInt(process.env.SEARCH_STARTS_PER_HOUR, 30, 1, 1_000),
    spawnSearchWorker,
    (task, code, error) => {
      const stats = scheduler.stats();
      log.info("Search worker exited", {
        searchQueryId: task.searchQueryId,
        code,
        error: error?.message,
        parentRssMb: Math.round(process.memoryUsage().rss / 1_048_576),
        ...stats,
      });
      if (code !== 0 || error) {
        void prisma.searchJob
          .updateMany({
            where: { searchQueryId: task.searchQueryId, status: { in: ["queued", "running"] } },
            data: {
              status: "failed",
              stage: "worker",
              progress: 100,
              error: error?.message ?? `Search worker exited with code ${code ?? "unknown"}`,
            },
          })
          .catch((updateError) => log.error("Failed to mark search worker job failed", updateError));
      }
    },
  );
  globalForScheduler.searchScheduler = scheduler;
  process.once("SIGTERM", () => scheduler.shutdown());
  process.once("SIGINT", () => scheduler.shutdown());
  return scheduler;
}
