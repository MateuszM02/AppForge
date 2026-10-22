// Runs the vendored camofox-browser server (camofox-browser/upstream/server.js) as a child process on 127.0.0.1:
// started on the first browser call, stopped after config.browser.idleMinutes without one, protected by a random
// access key so other programs on the machine cannot drive it. Crash telemetry (on by default upstream) is off.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../../server/src/log.js';
import { paths, repoRoot } from '../../server/src/paths.js';
import type { Config } from '../../server/src/config.js';

const log = logger('browser');
const UPSTREAM = path.join(repoRoot, 'camofox-browser', 'upstream');

/** Where camoufox-js keeps the downloaded browser (same rule as upstream postinstall.js). */
export function camoufoxCacheDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'camoufox');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'camoufox', 'camoufox', 'Cache');
  return path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'camoufox');
}

export function camoufoxInstalled(): boolean {
  return Boolean(process.env.CAMOUFOX_EXECUTABLE) || fs.existsSync(path.join(camoufoxCacheDir(), 'version.json'));
}

/** Downloads Camoufox (~300 MB) with the upstream postinstall script. */
export function fetchCamoufox(): boolean {
  const r = spawnSync(process.execPath, [path.join(UPSTREAM, 'postinstall.js')], { cwd: UPSTREAM, stdio: 'inherit', env: { ...process.env, CAMOFOX_SKIP_DOWNLOAD: '' } });
  return r.status === 0 && camoufoxInstalled();
}

async function freePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(preferred, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export class BrowserError extends Error {}

export class CamofoxManager {
  private child: ChildProcess | null = null;
  private baseUrl = '';
  private accessKey = crypto.randomBytes(24).toString('hex');
  private apiKey = crypto.randomBytes(24).toString('hex');
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  readonly userId = 'appforge';

  constructor(private readonly config: () => Config) {}

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  private async start(): Promise<void> {
    if (!camoufoxInstalled()) {
      throw new BrowserError('The Camoufox browser is not downloaded yet. Run `appforge setup browser` (about 300 MB) and try again.');
    }
    const port = await freePort(this.config().browser.port || 0);
    fs.mkdirSync(paths.browser, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      CAMOFOX_PORT: String(port),
      CAMOFOX_BIND_HOST: '127.0.0.1',
      CAMOFOX_ACCESS_KEY: this.accessKey,
      CAMOFOX_API_KEY: this.apiKey,
      CAMOFOX_CRASH_REPORT_ENABLED: 'false',
      PROMETHEUS_ENABLED: 'false',
      CAMOFOX_PROFILE_DIR: path.join(paths.browser, 'profiles'),
      CAMOFOX_COOKIES_DIR: path.join(paths.browser, 'cookies'),
      CAMOFOX_UPLOADS_DIR: path.join(paths.browser, 'uploads'),
      CAMOFOX_TRACES_DIR: path.join(paths.browser, 'traces'),
      NODE_ENV: 'production',
    };
    delete env.SENTRY_DSN;
    log.info(`starting camofox on 127.0.0.1:${port}`);
    const child = spawn(process.execPath, [path.join(UPSTREAM, 'server.js')], { cwd: UPSTREAM, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.baseUrl = `http://127.0.0.1:${port}`;
    const tail: string[] = [];
    const keep = (d: Buffer) => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        tail.push(line);
        if (tail.length > 30) tail.shift();
        log.debug(line);
      }
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('exit', (code) => {
      log.info(`camofox exited (${code})`);
      if (this.child === child) this.child = null;
    });

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new BrowserError(`The browser server stopped while starting:\n${tail.slice(-10).join('\n')}`);
      try {
        const r = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    await this.stop();
    throw new BrowserError(`The browser server did not start within 60 s:\n${tail.slice(-10).join('\n')}`);
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const minutes = this.config().browser.idleMinutes;
    if (minutes > 0) {
      this.idleTimer = setTimeout(() => void this.stop(), minutes * 60_000);
      this.idleTimer.unref();
    }
  }

  private async ensure(): Promise<void> {
    if (this.running) return;
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  /** One request to the camofox REST API (starts the server when needed). */
  async request<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'DELETE', p: string, body?: unknown, opts: { auth?: 'access' | 'api'; raw?: boolean } = {}): Promise<T> {
    await this.ensure();
    this.touch();
    const key = opts.auth === 'api' ? this.apiKey : this.accessKey;
    const res = await fetch(`${this.baseUrl}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (opts.raw) {
      if (!res.ok) throw new BrowserError(`${res.status}: ${await res.text()}`);
      return res as unknown as T;
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
    if (!res.ok) {
      const msg = (data as { error?: string }).error ?? text;
      throw new BrowserError(`Browser ${res.status}: ${msg}`);
    }
    return data as T;
  }

  /** Stops the browser and its server (they start again on the next call). */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await fetch(`${this.baseUrl}/stop`, { method: 'POST', headers: { Authorization: `Bearer ${this.accessKey}` }, signal: AbortSignal.timeout(5000) });
    } catch {
      // already down
    }
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
    }
    this.child = null;
  }
}
