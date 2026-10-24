// MCP tools of the repos group: find open-source projects by what they do (RepoRadar) and look inside any GitHub
// repository without cloning it.

import { z } from 'zod';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { fail, json, safe, text, type ForgeContext } from '../../server/src/context.js';
import { githubToken, ghApi, ghHeadSha, ghRaw, ghTree, parseRepo } from '../../server/src/github.js';
import { getSearch, isRunningHere, radar, searchSettings, startSearch, type RadarResult, type RadarSearch, type RadarStats } from './radar.js';

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
  const summary = r.analysis?.summary && !/; fit \d+%, future \d+%\.$/.test(r.analysis.summary) ? `   why: ${r.analysis.summary}` : '';
  const risks = (r.analysis?.risks ?? []).slice(0, 3).map(riskText).filter(Boolean);
  const pushed = m.pushedAt ? `   last push ${m.pushedAt.slice(0, 10)}${m.latestReleaseAt ? `, last release ${m.latestReleaseAt.slice(0, 10)}` : ''}` : '';
  return [head, desc, scores, summary, risks.length ? `   risks: ${risks.join('; ')}` : '', pushed, `   ${r.repo.url ?? ''}`].filter(Boolean).join('\n');
}

/**
 * Licences asked for per search. RepoRadar only prefers them (a mismatch scores lower); the tool promises
 * "allowed licences", so other licences are left out here, and the answer says how many.
 */
const licenceFilters = new Map<string, string[]>();

function formatSearch(s: RadarSearch): string {
  if (s.status === 'failed') return `Search ${s.searchId} failed: ${s.error ?? 'unknown error'}`;
  if (s.status !== 'completed') return `Search ${s.searchId} is still running (${s.stage ?? s.status}, ${s.progress}%). Call repo_search_result with this id in a little while.`;
  const allowed = licenceFilters.get(s.searchId)?.map((l) => l.toLowerCase());
  const results = allowed ? s.results.filter((r) => allowed.includes((r.repo.license ?? '').toLowerCase())) : s.results;
  const others = s.results.filter((r) => !results.includes(r));
  const hiddenNote = others.length
    ? `\n\n(${others.length} more matched but have other licences: ${[...new Set(others.map((r) => r.repo.license ?? 'none'))].join(', ')}.)`
    : '';
  const footer = s.stats ? `\n\n${formatStats(s.stats)}` : '';
  if (!results.length) return `No good matches for "${s.prompt}". Try describing the need differently or loosen the filters.${hiddenNote}${footer}`;
  return `Best matches for "${s.prompt}" (scores 0-1; fit = matches the need, future = maintenance outlook, underrated = good but little known):\n\n${results.map(formatResult).join('\n\n')}${hiddenNote}\n\nNext: repo_details or repo_read_file to look closer.${footer}`;
}

/** One line on what each stage did, so the agent (and the user) can judge how far to trust the list. */
export function formatStats(st: RadarStats): string {
  const r = st.rank;
  const llm = {
    used: `the local LLM picked the final list${st.llmDropped ? ` and dropped ${st.llmDropped} as off-topic` : ''}`,
    off: 'the LLM pick is off (repos.llm), so this is the cross-encoder order',
    unavailable: 'the local LLM is not available (run `appforge setup models`), so this is the cross-encoder order',
    failed: 'the local LLM did not answer in time, so this is the cross-encoder order',
  }[st.llm];
  const stages = r
    ? `${st.pool} candidates from ${st.queries.length} GitHub searches; ` +
      `the embedding model dropped ${r.belowSimilarity} and passed ${r.reranked} to the cross-encoder, which dropped ${r.belowRerankScore} and kept ${r.finalists}; ${llm}.`
    : `${st.pool} candidates; ${llm}.`;
  const secs = Object.values(st.seconds).reduce((a, b) => a + b, 0);
  return `How this was found: ${stages} (${Math.round(secs)} s)`;
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

/** Rejects when `p` takes longer than `ms`, so a tool never hangs on GitHub's rate limiter. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s (GitHub may be rate-limiting; check forge_status).`)), ms).unref()),
  ]);
}

/** RepoRadar's evidence and assessment for one repository (needs a GitHub login), never waiting forever. */
async function fullDetails(owner: string, repo: string, need: string | undefined, what: string) {
  return withTimeout((await radar()).repoDetails(`${owner}/${repo}`, need, searchSettings().rerank), 150_000, what);
}

/**
 * Without a GitHub login RepoRadar's evidence step cannot run (it uses GitHub's GraphQL API, which needs one), so
 * this gives the basic facts from 2 REST calls and the README from raw.githubusercontent.com.
 */
async function basicDetails(owner: string, repo: string) {
  const meta = await ghApi<Record<string, unknown> & { default_branch: string; license?: { spdx_id?: string } | null }>(`/repos/${owner}/${repo}`, { maxAgeSec: 3600 });
  const releases = await ghApi<Array<{ tag_name: string; published_at: string }>>(`/repos/${owner}/${repo}/releases?per_page=5`, { maxAgeSec: 3600 }).catch(() => []);
  const sha = await ghHeadSha(owner, repo);
  const readme = (await ghRaw(owner, repo, sha, 'README.md')) ?? (await ghRaw(owner, repo, sha, 'readme.md'));
  return {
    note: 'Basic facts only: log in to GitHub (gh auth login, or GITHUB_TOKEN) for the full evidence and risk analysis.',
    repo: {
      fullName: meta.full_name, description: meta.description, url: meta.html_url, stars: meta.stargazers_count, forks: meta.forks_count,
      openIssues: meta.open_issues_count, language: meta.language, license: meta.license?.spdx_id ?? null, topics: meta.topics,
      archived: meta.archived, fork: meta.fork, createdAt: meta.created_at, pushedAt: meta.pushed_at, homepage: meta.homepage,
    },
    recentReleases: releases.map((r) => ({ tag: r.tag_name, date: r.published_at })),
    readme: readme ? readme.slice(0, 3000) : null,
  };
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
        'then narrows a pool of up to a few thousand repositories with local models (an embedding model, a cross-encoder and a ' +
        'small LLM, all on this computer) and flags risks from evidence (releases, issues, contributors). Takes 1-3 ' +
        'minutes; if it is not done in time you get an id for repo_search_result. Use before building something new.',
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
      if (a.license?.length) licenceFilters.set(id, a.license);
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
      if (!githubToken()) return json(await basicDetails(owner, repo));
      const d = await fullDetails(owner, repo, a.need, 'repo_details');
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
      const rows = await Promise.all(
        a.repos.map(async (ref) => {
          const { owner, repo } = parseRepo(ref);
          try {
            if (!githubToken()) return await basicDetails(owner, repo);
            const d = await fullDetails(owner, repo, a.need, 'repo_compare');
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
