import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runOmb(cwd: string, argv: string[]) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const ombBin = join(repoRoot, 'dist', 'cli', 'omb.js');
  return spawnSync(process.execPath, [ombBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      OMB_AUTO_UPDATE: '0',
      OMB_NOTIFY_FALLBACK: '0',
      OMB_HOOK_DERIVED_SIGNALS: '0',
    },
  });
}

describe('omb adapt help', () => {
  it('documents adapt in top-level help and routes adapt-local help output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omb-adapt-help-'));
    try {
      const mainHelp = runOmb(cwd, ['--help']);
      assert.equal(mainHelp.status, 0, mainHelp.stderr || mainHelp.stdout);
      assert.match(mainHelp.stdout, /omb adapt\s+Scaffold OMB-owned adapter foundations for persistent external targets/i);

      const adaptHelp = runOmb(cwd, ['adapt', '--help']);
      assert.equal(adaptHelp.status, 0, adaptHelp.stderr || adaptHelp.stdout);
      assert.match(adaptHelp.stdout, /Usage: omb adapt <target> <probe\|status\|init\|envelope\|doctor>/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
