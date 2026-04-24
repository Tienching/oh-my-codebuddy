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
    env: process.env,
  });
}

describe('omb session help', () => {
  it('documents the session search command in help output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omb-session-help-'));
    try {
      const mainHelp = runOmb(cwd, ['--help']);
      assert.equal(mainHelp.status, 0, mainHelp.stderr || mainHelp.stdout);
      assert.match(mainHelp.stdout, /omb resume\s+Resume a previous interactive CodeBuddy session/i);
      assert.match(mainHelp.stdout, /omb autoresearch\s+Launch thin-supervisor autoresearch with keep\/discard\/reset parity/i);
      assert.match(mainHelp.stdout, /omb session\s+Search prior local session transcripts/i);

      const sessionHelp = runOmb(cwd, ['session', '--help']);
      assert.equal(sessionHelp.status, 0, sessionHelp.stderr || sessionHelp.stdout);
      assert.match(sessionHelp.stdout, /omb session search <query>|omb session search <query>/i);
      assert.match(sessionHelp.stdout, /--since <spec>/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
