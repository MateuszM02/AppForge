import { z } from "zod";

export const filtersSchema = z
  .object({
    language: z.string().nullable().optional(),
    license: z.array(z.string()).optional(),
    includeSmallProjects: z.boolean().optional(),
    minFutureScore: z.number().nullable().optional(),
    projectType: z
      .enum([
        "library", "framework", "cli", "app", "template", "demo", "research",
        "tutorial", "awesome-list", "plugin", "extension", "dataset", "any",
      ])
      .optional(),
    pushedWithinDays: z.number().nullable().optional(),
    minStars: z.number().nullable().optional(),
  })
  .optional();

export const searchRequestSchema = z.object({
  prompt: z.string().min(3, "prompt too short").max(1_000, "prompt too long"),
  filters: filtersSchema,
});

export const searchWorkerInputSchema = searchRequestSchema.extend({
  searchQueryId: z.string().uuid(),
  requestId: z.string().uuid(),
});

export type SearchWorkerInput = z.infer<typeof searchWorkerInputSchema>;
