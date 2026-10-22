import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const hook = new URL('./post-install.sh', import.meta.url);

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'camofox-ytdlp-'));
  const bin = join(dir, 'bin');
  const fixture = join(dir, 'fixture');
  const calls = join(dir, 'curl-calls');
  const installPath = join(dir, 'yt-dlp');

  writeFileSync(fixture, '#!/bin/sh\necho yt-dlp fixture\n');
  writeFileSync(join(dir, 'curl'), `#!/bin/sh
set -eu
printf '%s\\n' "$@" > "$CURL_CALLS"
cp "$YT_DLP_FIXTURE" "$4"
`);
  writeFileSync(join(dir, 'sha256sum'), `#!/bin/sh
set -eu
[ "$1" = '-c' ] && [ "$2" = '-' ]
read -r expected path
actual=$(shasum -a 256 "$path" | awk '{print $1}')
[ "$expected" = "$actual" ]
`);
  chmodSync(join(dir, 'curl'), 0o755);
  chmodSync(join(dir, 'sha256sum'), 0o755);

  return {
    dir,
    calls,
    fixture,
    installPath,
    env(overrides = {}) {
      return {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CURL_CALLS: calls,
        YT_DLP_FIXTURE: fixture,
        YT_DLP_INSTALL_PATH: installPath,
        YT_DLP_VERSION: 'test-release',
        YT_DLP_ASSET: 'test-asset',
        ...overrides,
      };
    },
  };
}

describe('yt-dlp post-install hook', () => {
  let harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    rmSync(harness.dir, { recursive: true, force: true });
  });

  it('downloads the pinned release, verifies it, and makes it executable', () => {
    const digest = createHash('sha256').update(readFileSync(harness.fixture)).digest('hex');

    execFileSync('sh', [hook.pathname], {
      env: harness.env({ YT_DLP_SHA256: digest }),
      stdio: 'pipe',
    });

    expect(readFileSync(harness.installPath)).toEqual(readFileSync(harness.fixture));
    expect(statSync(harness.installPath).mode & 0o111).not.toBe(0);
    expect(readFileSync(harness.calls, 'utf8')).toBe([
      '-fL',
      'https://github.com/yt-dlp/yt-dlp/releases/download/test-release/test-asset',
      '-o',
      harness.installPath,
      '',
    ].join('\n'));
  });

  it('fails before chmod when the downloaded binary digest differs', () => {
    expect(() => execFileSync('sh', [hook.pathname], {
      env: harness.env({ YT_DLP_SHA256: '0'.repeat(64) }),
      stdio: 'pipe',
    })).toThrow();

    expect(statSync(harness.installPath).mode & 0o111).toBe(0);
  });
});
