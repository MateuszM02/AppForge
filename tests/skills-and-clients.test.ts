import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { frontMatter, pluginLocation } from '../skill-sources/src/sync.js';
import { parseJsonc, registerClients } from '../server/src/clients.js';
import type { SkillSourceConfig } from '../server/src/config.js';

const src: SkillSourceConfig = { key: 'k', owner: 'anthropics', repo: 'claude-plugins-official', kind: 'marketplace', enabled: true };
const sha = 'a'.repeat(40);

test('marketplace plugin sources: in-repo path, url and git-subdir', () => {
  assert.deepEqual(pluginLocation(src, sha, { name: 'x', source: './plugins/x' }), { owner: 'anthropics', repo: 'claude-plugins-official', ref: sha, path: 'plugins/x' });
  assert.deepEqual(pluginLocation(src, sha, { name: 'y', source: { source: 'url', url: 'https://github.com/o/r.git', sha: 'b'.repeat(40) } }), {
    owner: 'o',
    repo: 'r',
    ref: 'b'.repeat(40),
    path: '',
  });
  assert.deepEqual(pluginLocation(src, sha, { name: 'z', source: { source: 'git-subdir', url: 'https://github.com/o/r.git', path: 'plugins/z', ref: 'v1' } }), {
    owner: 'o',
    repo: 'r',
    ref: 'v1',
    path: 'plugins/z',
  });
  assert.equal(pluginLocation(src, sha, { name: 'w', source: { source: 'url', url: 'https://gitlab.com/o/r.git' } }), null);
});

test('front matter: YAML, and a fallback for descriptions YAML rejects', () => {
  assert.deepEqual(frontMatter('---\nname: pdf\ndescription: "Read PDFs"\n---\nbody'), { name: 'pdf', description: 'Read PDFs' });
  assert.equal(frontMatter('---\nname: a\ndescription: Use when: things: happen\n---\n').description, 'Use when: things: happen');
  assert.deepEqual(frontMatter('no front matter'), {});
});

test('VS Code registration is idempotent, keeps other servers and makes a backup', () => {
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), 'appforge-clients-'));
  const saved = { APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, HOME: process.env.HOME };
  process.env.APPDATA = appdata;
  process.env.XDG_CONFIG_HOME = appdata;
  const user = path.join(appdata, 'Code', 'User');
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, 'mcp.json'), '{\n  // mine\n  "servers": { "other": { "type": "stdio", "command": "x" }, },\n}\n');
  try {
    assert.equal(registerClients({ clients: ['vscode'] })[0]?.status, 'added');
    assert.equal(registerClients({ clients: ['vscode'] })[0]?.status, 'unchanged');
    const doc = parseJsonc(fs.readFileSync(path.join(user, 'mcp.json'), 'utf8')) as { servers: Record<string, { command: string }> };
    assert.ok(doc.servers.other);
    assert.equal(doc.servers.appforge?.command, process.execPath);
    assert.ok(fs.existsSync(path.join(user, 'mcp.json.appforge-backup')));
    assert.equal(registerClients({ clients: ['vscode'], remove: true })[0]?.status, 'removed');
    assert.equal(registerClients({ clients: ['vscode'], remove: true })[0]?.status, 'absent');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
