import { prisma } from "../src/lib/db";
import { createLogger } from "../src/lib/logger";
import { runSearch } from "../src/lib/pipeline/runSearch";
import { searchWorkerInputSchema } from "../src/lib/pipeline/searchRequest";

const log = createLogger("search-worker");

async function readStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const parsed = searchWorkerInputSchema.safeParse(JSON.parse(await readStdin()));
  if (!parsed.success) throw new Error(`Invalid worker input: ${parsed.error.message}`);

  const startedAt = Date.now();
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 1_000);
  sampler.unref();

  try {
    await runSearch(parsed.data.searchQueryId, parsed.data.prompt, parsed.data.filters);
    const job = await prisma.searchJob.findFirst({
      where: { searchQueryId: parsed.data.searchQueryId },
      select: { status: true },
    });
    if (job?.status !== "completed") throw new Error(`Search finished with status ${job?.status ?? "missing"}`);
  } finally {
    clearInterval(sampler);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    log.info("Search worker memory", {
      searchQueryId: parsed.data.searchQueryId,
      peakRssMb: Math.round(peakRss / 1_048_576),
      finalRssMb: Math.round(process.memoryUsage().rss / 1_048_576),
      durationMs: Date.now() - startedAt,
    });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  log.error("Search worker failed", error);
  process.exitCode = 1;
});
