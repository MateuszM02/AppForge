// MCP tools of the browser group, on top of the camofox REST API.

import fs from 'node:fs';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fail, safe, type ForgeContext } from '../../server/src/context.js';
import { CamofoxManager } from './manager.js';

let manager: CamofoxManager | null = null;

export function camofox(ctx: Pick<ForgeContext, 'config'>): CamofoxManager {
  manager ??= new CamofoxManager(ctx.config);
  return manager;
}

const MACROS = [
  '@google_search',
  '@youtube_search',
  '@amazon_search',
  '@reddit_search',
  '@wikipedia_search',
  '@twitter_search',
  '@yelp_search',
  '@spotify_search',
  '@netflix_search',
  '@linkedin_search',
  '@instagram_search',
  '@tiktok_search',
  '@twitch_search',
] as const;

interface Snapshot {
  url?: string;
  snapshot?: string;
  refsCount?: number;
  truncated?: boolean;
  totalChars?: number;
  hasMore?: boolean;
  nextOffset?: number;
  screenshot?: { data?: string; mimeType?: string };
}

function snapshotResult(tabId: string, s: Snapshot, prefix = ''): CallToolResult {
  const more = s.hasMore ? `\n\n[Page continues: call browser_snapshot with tabId=${tabId} offset=${s.nextOffset}]` : '';
  const content: CallToolResult['content'] = [
    { type: 'text', text: `${prefix}tab ${tabId} | ${s.url ?? ''} | ${s.refsCount ?? 0} refs\n\n${s.snapshot ?? ''}${more}` },
  ];
  if (s.screenshot?.data) content.push({ type: 'image', data: s.screenshot.data, mimeType: s.screenshot.mimeType ?? 'image/png' });
  return { content };
}

/** Netscape cookies.txt (what browser "export cookies" extensions write) -> Playwright cookies. */
export function parseNetscapeCookies(text: string, domainSuffix?: string) {
  const out: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Lax' }> = [];
  for (let line of text.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true;
      line = line.slice('#HttpOnly_'.length);
    }
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const [domain, , cpath, secure, expires, name, value] = f as [string, string, string, string, string, string, string];
    if (domainSuffix && !domain.replace(/^\./, '').endsWith(domainSuffix.replace(/^\./, ''))) continue;
    out.push({ name, value, domain, path: cpath || '/', expires: Number(expires) || -1, httpOnly, secure: secure.toUpperCase() === 'TRUE', sameSite: 'Lax' });
  }
  return out;
}

export function registerBrowserTools(ctx: ForgeContext): void {
  const { server } = ctx;
  const cf = () => camofox(ctx);
  const uid = () => cf().userId;
  ctx.onClose(() => manager?.stop());

  const snap = async (tabId: string, offset?: number, screenshot?: boolean) => {
    const q = new URLSearchParams({ userId: uid() });
    if (offset) q.set('offset', String(offset));
    if (screenshot) q.set('includeScreenshot', 'true');
    return cf().request<Snapshot>('GET', `/tabs/${encodeURIComponent(tabId)}/snapshot?${q}`);
  };

  server.registerTool(
    'browser_open',
    {
      title: 'Open a page',
      description:
        'Open a URL in a new tab of a stealth browser (Camoufox; gets past most bot checks, e.g. Google, Cloudflare). ' +
        'Returns the tab id and an accessibility snapshot of the page: text plus element refs (e1, e2, ...) for browser_act. ' +
        'Use it to read docs, READMEs, issue threads and sites that block plain HTTP clients.',
      inputSchema: {
        url: z.string().describe('Full URL, e.g. https://example.com'),
        session: z.string().optional().describe('Separate cookie jar, e.g. per site or account. Default: one shared session.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    safe(async (a) => {
      const tab = await cf().request<{ tabId: string }>('POST', '/tabs', { url: a.url, userId: uid(), sessionKey: a.session ?? 'default' });
      return snapshotResult(tab.tabId, await snap(tab.tabId));
    }),
  );

  server.registerTool(
    'browser_snapshot',
    {
      title: 'Read the page',
      description: 'Current accessibility snapshot of a tab (text and element refs). Long pages come in parts: pass offset to read on. screenshot=true adds an image.',
      inputSchema: { tabId: z.string(), offset: z.number().int().min(0).optional(), screenshot: z.boolean().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a) => snapshotResult(a.tabId, await snap(a.tabId, a.offset, a.screenshot))),
  );

  server.registerTool(
    'browser_act',
    {
      title: 'Click, type, press, scroll',
      description:
        'Interact with a tab by element ref from the last snapshot (or a CSS selector): click, type (text, optional submit with Enter), ' +
        'press a key (Enter, Escape, ArrowDown, ...), select an option, or scroll. Returns the updated snapshot.',
      inputSchema: {
        tabId: z.string(),
        action: z.enum(['click', 'type', 'press', 'select', 'scroll']),
        ref: z.string().optional().describe('Element ref, e.g. e12.'),
        selector: z.string().optional().describe('CSS selector instead of a ref.'),
        text: z.string().optional().describe('type: the text; select: the option value or label.'),
        submit: z.boolean().optional().describe('type: press Enter afterwards.'),
        key: z.string().optional().describe('press: key name.'),
        direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('scroll direction (default down).'),
        amount: z.number().optional().describe('scroll: pixels (default one screen).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async (a) => {
      const base = { userId: uid(), ...(a.ref ? { ref: a.ref } : {}), ...(a.selector ? { selector: a.selector } : {}) };
      const tab = encodeURIComponent(a.tabId);
      switch (a.action) {
        case 'click':
          if (!a.ref && !a.selector) return fail('click needs ref or selector.');
          await cf().request('POST', `/tabs/${tab}/click`, base);
          break;
        case 'type':
          if (a.text === undefined) return fail('type needs text.');
          await cf().request('POST', `/tabs/${tab}/type`, { ...base, text: a.text, pressEnter: a.submit ?? false });
          break;
        case 'press':
          if (!a.key) return fail('press needs key.');
          await cf().request('POST', `/tabs/${tab}/press`, { userId: uid(), key: a.key });
          break;
        case 'select':
          if (a.text === undefined) return fail('select needs text (the option).');
          await cf().request('POST', `/tabs/${tab}/select`, { ...base, option: a.text });
          break;
        case 'scroll':
          await cf().request('POST', `/tabs/${tab}/scroll`, { userId: uid(), direction: a.direction ?? 'down', ...(a.amount ? { amount: a.amount } : {}) });
          break;
      }
      return snapshotResult(a.tabId, await snap(a.tabId), `${a.action} done. `);
    }),
  );

  server.registerTool(
    'browser_navigate',
    {
      title: 'Go to a page or search',
      description:
        'In an existing tab: go to a URL, run a search macro (@google_search, @youtube_search, @reddit_search, @wikipedia_search, ...), ' +
        'or go back, forward or refresh. Returns the new snapshot.',
      inputSchema: {
        tabId: z.string(),
        url: z.string().optional(),
        macro: z.enum(MACROS).optional(),
        query: z.string().optional().describe('Search words for the macro.'),
        history: z.enum(['back', 'forward', 'refresh']).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    safe(async (a) => {
      const tab = encodeURIComponent(a.tabId);
      if (a.history) await cf().request('POST', `/tabs/${tab}/${a.history}`, { userId: uid() });
      else if (a.macro) await cf().request('POST', `/tabs/${tab}/navigate`, { userId: uid(), macro: a.macro, query: a.query ?? '' });
      else if (a.url) await cf().request('POST', `/tabs/${tab}/navigate`, { userId: uid(), url: a.url });
      else return fail('Give url, macro (+query) or history.');
      return snapshotResult(a.tabId, await snap(a.tabId));
    }),
  );

  server.registerTool(
    'browser_extract',
    {
      title: 'Extract structured data',
      description:
        'Pull structured data out of the page with a JSON Schema. Map properties to snapshot refs with "x-ref" ' +
        '(e.g. {"type":"object","properties":{"price":{"type":"string","x-ref":"e14"}}}).',
      inputSchema: { tabId: z.string(), schema: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a) => {
      const r = await cf().request('POST', `/tabs/${encodeURIComponent(a.tabId)}/extract`, { userId: uid(), schema: a.schema });
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    }),
  );

  server.registerTool(
    'browser_tabs',
    {
      title: 'List or close tabs',
      description: 'list: open tabs with their URLs. close: close one tab (tabId) or all tabs (no tabId) and stop the browser.',
      inputSchema: { action: z.enum(['list', 'close']), tabId: z.string().optional() },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    safe(async (a) => {
      if (a.action === 'list') {
        if (!cf().running) return { content: [{ type: 'text', text: 'The browser is not running (no tabs).' }] };
        const r = await cf().request('GET', `/tabs?${new URLSearchParams({ userId: uid() })}`);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (a.tabId) {
        await cf().request('DELETE', `/tabs/${encodeURIComponent(a.tabId)}?${new URLSearchParams({ userId: uid() })}`);
        return { content: [{ type: 'text', text: `Closed tab ${a.tabId}.` }] };
      }
      await cf().stop();
      return { content: [{ type: 'text', text: 'Closed all tabs and stopped the browser.' }] };
    }),
  );

  server.registerTool(
    'browser_import_cookies',
    {
      title: 'Import cookies',
      description:
        'Load cookies from a Netscape cookies.txt file (exported from the user\'s own browser) so pages open logged in. ' +
        'Only with the user\'s explicit consent; the file stays local.',
      inputSchema: {
        file: z.string().describe('Absolute path to cookies.txt'),
        domain: z.string().optional().describe('Only cookies of this domain, e.g. github.com'),
        session: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    safe(async (a) => {
      const cookies = parseNetscapeCookies(fs.readFileSync(a.file, 'utf8'), a.domain);
      if (!cookies.length) return fail('No cookies found in that file (for that domain).');
      await cf().request('POST', `/sessions/${encodeURIComponent(uid())}/cookies`, { cookies, sessionKey: a.session }, { auth: 'api' });
      return { content: [{ type: 'text', text: `Imported ${cookies.length} cookies.` }] };
    }),
  );

  if (ctx.config().tools.browserEvaluate) {
    server.registerTool(
      'browser_evaluate',
      {
        title: 'Run JavaScript in the page',
        description: 'Evaluate a JavaScript expression in the page and return its value. Enabled by the user in settings (tools.browserEvaluate).',
        inputSchema: { tabId: z.string(), expression: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      safe(async (a) => {
        const r = await cf().request('POST', `/tabs/${encodeURIComponent(a.tabId)}/evaluate`, { userId: uid(), expression: a.expression });
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }),
    );
  }
}
