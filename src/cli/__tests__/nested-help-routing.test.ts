import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

describe('nested help routing', () => {
  for (const [argv, expectedUsage] of [
    [['ask', '--help'], /Usage:\s*omb ask <claude\|gemini> <question or task>/i],
    [['autoresearch', '--help'], /Usage:[\s\S]*omb autoresearch <mission-dir>/i],
    [['hud', '--help'], /Usage:\s*\n\s*omb hud\s+Show current HUD state/i],
    [['hooks', '--help'], /Usage:\s*\n\s*omb hooks init/i],
    [['state', '--help'], /Usage:\s*omb state <read\|write\|clear\|list-active\|get-status>/i],
    [['tmux-hook', '--help'], /Usage:\s*\n\s*omb tmux-hook init/i],
    [['ralph', '--help'], /omb ralph - Launch the selected leader CLI with ralph persistence mode active/i],
  ] satisfies Array<[string[], RegExp]>) {
    it(`routes ${argv.join(' ')} to command-local help`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omb-nested-help-'));
      try {
        const result = runOmb(cwd, argv);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, expectedUsage);
        assert.doesNotMatch(result.stdout, /oh-my-codebuddy \(omb\) - Multi-agent orchestration for Codex CLI/i);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

  it('routes `omb state read` through the top-level CLI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omb-state-route-'));
    try {
      const result = runOmb(cwd, ['state', 'read', '--input', '{"mode":"ralph"}', '--json']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout.trim(), /^\{"exists":false,"mode":"ralph"\}$/);
      assert.doesNotMatch(result.stdout, /Unknown command: state/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
