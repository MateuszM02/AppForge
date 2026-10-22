import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { searchRequestSchema } from "@/lib/pipeline/searchRequest";
import { getSearchScheduler } from "@/lib/pipeline/searchScheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const log = createLogger("api:search");

export async function GET(req: Request) {
  const requestId = crypto.randomUUID();
  log.debug("Search route warm-up", {
    requestId,
    purpose: req.headers.get("x-reporadar-purpose"),
    userAgent: req.headers.get("user-agent"),
    referer: req.headers.get("referer"),
  });
  return NextResponse.json(
    { status: "ready", requestId },
    { headers: { "x-reporadar-request-id": requestId } },
  );
}

export async function POST(req: Request) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const json = await req.json().catch(() => null);
  const parsed = searchRequestSchema.safeParse(json);
  if (!parsed.success) {
    log.warn("Rejected invalid search request", {
      requestId,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { prompt, filters } = parsed.data;

  log.info("Accepted search request", {
    requestId,
    promptLength: prompt.length,
    promptPreview: prompt.slice(0, 120),
    filters,
    userAgent: req.headers.get("user-agent"),
    referer: req.headers.get("referer"),
  });

  let query: { id: string };
  try {
    query = await prisma.searchQuery.create({
      data: { rawPrompt: prompt, normalizedPrompt: prompt },
      select: { id: true },
    });
    await prisma.searchJob.create({
      data: { searchQueryId: query.id, status: "queued", progress: 0 },
    });
  } catch (error) {
    log.error("Failed to create search job", error, { requestId });
    return NextResponse.json(
      {
        error: "Could not create search job",
        requestId,
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500, headers: { "x-reporadar-request-id": requestId } },
    );
  }

  const scheduler = getSearchScheduler();
  const admission = scheduler.enqueue({
    searchQueryId: query.id,
    prompt,
    filters,
    requestId,
  });
  if (admission === "hourly_limit" || admission === "queue_full") {
    await prisma.searchQuery.delete({ where: { id: query.id } }).catch(() => {});
    return NextResponse.json(
      { error: admission === "hourly_limit" ? "Search rate limit reached" : "Search queue is full", requestId },
      {
        status: 429,
        headers: {
          "x-reporadar-request-id": requestId,
          "retry-after": admission === "hourly_limit" ? "3600" : "120",
        },
      },
    );
  }

  log.info("Search job queued", {
    requestId,
    searchQueryId: query.id,
    admission,
    ...scheduler.stats(),
    durationMs: Date.now() - startedAt,
  });

  return NextResponse.json(
    { searchId: query.id, status: "queued", requestId },
    { headers: { "x-reporadar-request-id": requestId } },
  );
}
