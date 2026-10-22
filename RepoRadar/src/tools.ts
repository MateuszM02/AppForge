// MCP tools of the repos group: find open-source projects by what they do (RepoRadar) and look inside any GitHub
// repository without cloning it.

import { z } from 'zod';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { fail, json, safe, text, type ForgeContext } from '../../server/src/context.js';
import { ghHeadSha, ghRaw, ghTree, parseRepo } from '../../server/src/github.js';
import { getSearch, isRunningHere, radar, startSearch, type RadarResult, type RadarSearch } from './radar.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function n(v: number | null | undefined, digits = 2): string {
  return typeof v === 'number' ? v.toFixed(digits) : '-';
}

function riskText(r: unknown): string {
  if (typeof r === 'string') return r;
  const o = r as { label?: string; type?: string; severity?: string; detail?: string; description?: string };
  return [o.label ?? o.type, o.detail ?? o.description].filter(Boolean).join(': ');
}

function formatResult(r: RadarResult): string {
  const m = r.metrics ?? {};
  const head = `${r.rank ?? '?'}. ${r.repo.fullName} (${m.stars ?? '?'}★, ${r.repo.language ?? '?'}, ${r.repo.license ?? 'no licence'})`;
  const scores = `   total ${n(r.scores.total)} | fit ${n(r.scores.fit)} | future ${n(r.scores.future)} | underrated ${n(r.scores.underrated)}`;
  const desc = r.repo.description ? `   ${r.repo.description}` : '';
  const summary = r.analysis?.summary ? `   why: ${r.analysis.summary}` : '';
  const risks = (r.analysis?.risks ?? []).slice(0, 3).map(riskText).filter(Boolean);
  const pushed = m.pushedAt ? `   last push ${m.pushedAt.slice(0, 10)}${m.latestReleaseAt ? `, last release ${m.latestReleaseAt.slice(0, 10)}` : ''}` : '';
  return [head, desc, scores, summary, risks.length ? `   risks: ${risks.join('; ')}` : '', pushed, `   ${r.repo.url ?? ''}`].filter(Boolean).join('\n');
}

function formatSearch(s: RadarSearch): string {
  if (s.status === 'failed') return `Search ${s.searchId} failed: ${s.error ?? 'unknown error'}`;
  if (s.status !== 'completed') return `Search ${s.searchId} is still running (${s.stage ?? s.status}, ${s.progress}%). Call repo_search_result with this id in a little while.`;
  if (!s.results.length) return `No good matches for "${s.prompt}". Try describing the need differently or loosen the filters.`;
  return `Best matches for "${s.prompt}" (scores 0-1; fit = matches the need, future = maintenance outlook, underrated = good but little known):\n\n${s.results.map(formatResult).join('\n\n')}\n\nNext: repo_details or repo_read_file to look closer.`;
}

async function waitFor(id: string, seconds: number, extra: Extra): Promise<RadarSearch | null> {
  const token = extra._meta?.progressToken;
  const deadline = Date.now() + seconds * 1000;
  let last: RadarSearch | null = null;
  while (Date.now() < deadline && !extra.signal.aborted) {
    last = await getSearch(id);
    if (!last || last.status === 'completed' || last.status === 'failed') return last;
    if (token !== undefined) {
      await extra
        .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: last.progress, total: 100, message: last.stage ?? last.status } })
        .catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

export function registerRepoTools(ctx: ForgeContext): void {
  const { server } = ctx;

  server.registerTool(
    'repo_search',
    {
      title: 'Find open-source projects',
      description:
        'Find GitHub repositories by what they should do, not by name ("self-hosted markdown wiki with git sync", ' +
        '"alternative to Firebase Auth for Next.js"). Searches GitHub several ways plus awesome-lists and package registries, ' +
        'ranks with local embeddings and evidence (README, releases, issues, contributors) and flags risks. Takes about a ' +
        'minute; if it is not done in time you get an id for repo_search_result. Use before building something new.',
      inputSchema: {
        need: z.string().min(3).describe('What the project should do, in plain words.'),
        language: z.string().optional().describe('Programming language, e.g. TypeScript.'),
        minStars: z.number().int().min(0).optional(),
        pushedWithinDays: z.number().int().min(1).optional().describe('Only repos with commits in the last N days.'),
        license: z.array(z.string()).optional().describe('Allowed SPDX ids, e.g. ["MIT","Apache-2.0"].'),
        includeSmallProjects: z.boolean().optional().describe('Also rank projects with few stars.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a, extra: Extra) => {
      const id = await startSearch(a.need, {
        language: a.language ?? null,
        minStars: a.minStars ?? null,
        pushedWithinDays: a.pushedWithinDays ?? null,
        license: a.license,
        includeSmallProjects: a.includeSmallProjects,
      });
      const res = await waitFor(id, ctx.config().repos.waitSeconds, extra);
      return text(res ? formatSearch(res) : `Search started: ${id}. Call repo_search_result with this id.`);
    }),
  );

  server.registerTool(
    'repo_search_result',
    {
      title: 'Get search results',
      description: 'Results of a repo_search that was still running. Waits up to 30 s more.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async (a, extra: Extra) => {
      const res = await waitFor(a.id, 30, extra);
      if (!res) return fail(`No search ${a.id}.`);
      if (res.status !== 'completed' && res.status !== 'failed' && !isRunningHere(a.id)) {
        return fail(`Search ${a.id} was interrupted (the server restarted). Run repo_search again.`);
      }
      return text(formatSearch(res));
    }),
  );

  server.registerTool(
    'repo_details',
    {
      title: 'Inspect a repository',
      description:
        'Evidence about one GitHub repository: description, stars, licence, activity, releases, issues and PRs, contributors, ' +
        'manifests, docs signals, a README excerpt, plus a health/risk assessment. Pass need to score how well it fits.',
      inputSchema: {
        repo: z.string().describe('"owner/name" or a GitHub URL.'),
        need: z.string().optional().describe('What you want it for (improves the fit score).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a) => {
      const { owner, repo } = parseRepo(a.repo);
      const d = await (await radar()).repoDetails(`${owner}/${repo}`, a.need);
      if (!d) return fail(`Repository ${owner}/${repo} not found.`);
      const e = d.evidence as Record<string, unknown> & { readme?: string | null; candidate?: unknown };
      const readme = typeof e.readme === 'string' ? e.readme.slice(0, 3000) : null;
      return json({ repo: e.candidate, analysis: d.analysis, evidence: { ...e, candidate: undefined, readme } });
    }),
  );

  server.registerTool(
    'repo_compare',
    {
      title: 'Compare repositories',
      description: 'Side-by-side key facts and scores of 2-6 repositories (stars, activity, releases, contributors, licence, risks).',
      inputSchema: { repos: z.array(z.string()).min(2).max(6), need: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a) => {
      const r = await radar();
      const rows = await Promise.all(
        a.repos.map(async (ref) => {
          const { owner, repo } = parseRepo(ref);
          try {
            const d = await r.repoDetails(`${owner}/${repo}`, a.need);
            if (!d) return { repo: `${owner}/${repo}`, error: 'not found' };
            const c = d.evidence.candidate as Record<string, unknown>;
            const e = d.evidence as Record<string, unknown>;
            const an = d.analysis as Record<string, unknown> & { risks?: unknown[] };
            return {
              repo: `${owner}/${repo}`,
              stars: c.stars,
              language: c.primaryLanguage,
              license: c.licenseSpdx,
              pushedAt: c.pushedAt,
              archived: c.isArchived,
              releases: e.releaseCount,
              latestRelease: e.latestReleaseAt,
              contributors: e.contributorCount,
              openIssues: e.openIssues,
              mergedPRs: e.mergedPRs,
              fit: an.fit,
              future: an.future,
              total: an.total,
              risks: (an.risks ?? []).slice(0, 4).map(riskText),
            };
          } catch (err) {
            return { repo: `${owner}/${repo}`, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      return json(rows);
    }),
  );

  server.registerTool(
    'repo_tree',
    {
      title: 'List repository files',
      description: 'Files and folders of a GitHub repository (or one folder of it) without cloning. Costs 1-2 GitHub API requests, then cached.',
      inputSchema: {
        repo: z.string().describe('"owner/name" or a GitHub URL.'),
        path: z.string().optional().describe('Folder inside the repo; default the root.'),
        ref: z.string().optional().describe('Branch, tag or commit; default the default branch.'),
        recursive: z.boolean().optional().describe('Whole subtree instead of one level (default false).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a) => {
      const { owner, repo } = parseRepo(a.repo);
      const sha = await ghHeadSha(owner, repo, a.ref ?? 'HEAD');
      const tree = await ghTree(owner, repo, sha);
      const prefix = a.path ? a.path.replace(/^\/+|\/+$/g, '') + '/' : '';
      const inside = tree.filter((t) => t.path.startsWith(prefix) && t.path !== prefix.slice(0, -1));
      const shown = a.recursive ? inside : inside.filter((t) => !t.path.slice(prefix.length).includes('/'));
      const lines = shown.slice(0, 500).map((t) => `${t.type === 'tree' ? 'dir ' : 'file'} ${t.path.slice(prefix.length)}${t.type === 'blob' && t.size !== undefined ? ` (${t.size} B)` : ''}`);
      const more = shown.length > 500 ? `\n… ${shown.length - 500} more (narrow with path).` : '';
      return text(`${owner}/${repo}@${sha.slice(0, 7)}/${prefix}\n${lines.join('\n')}${more}`);
    }),
  );

  server.registerTool(
    'repo_read_file',
    {
      title: 'Read a repository file',
      description: 'Text of one file from a GitHub repository without cloning (no API quota used). Long files come in parts: pass offset to continue.',
      inputSchema: {
        repo: z.string(),
        path: z.string(),
        ref: z.string().optional().describe('Branch, tag or commit; default the default branch.'),
        offset: z.number().int().min(0).optional().describe('Character offset to start at.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a) => {
      const { owner, repo } = parseRepo(a.repo);
      const ref = await ghHeadSha(owner, repo, a.ref ?? 'HEAD');
      const body = await ghRaw(owner, repo, ref, a.path.replace(/^\/+/, ''));
      if (body === null) return fail(`${a.path} not found in ${owner}/${repo}@${ref}. Use repo_tree to see the files.`);
      const start = a.offset ?? 0;
      const chunk = body.slice(start, start + 40_000);
      const rest = body.length - start - chunk.length;
      return text(chunk + (rest > 0 ? `\n\n[${rest} more characters: call again with offset=${start + chunk.length}]` : '')) as CallToolResult;
    }),
  );
}
