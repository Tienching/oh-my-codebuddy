import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function runOmb(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const ombBin = join(repoRoot, 'dist', 'cli', 'omb.js');
  const result = spawnSync(process.execPath, [ombBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...envOverrides,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
  };
}

describe('omb resume', () => {
  it('maps --last to CodeBuddy --continue through the normal launch wrapper', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-resume-cli-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodebuddyPath = join(fakeBin, 'codebuddy');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(fakeCodebuddyPath, '#!/bin/sh\nprintf \'fake-codebuddy:%s\\n\' \"$*\"\n');
      await chmod(fakeCodebuddyPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmb(wd, ['resume', '--last'], {
        HOME: home,
        PATH: fakeBin,
        OMB_AUTO_UPDATE: '0',
        OMB_NOTIFY_FALLBACK: '0',
        OMB_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codebuddy:--continue\b/);
      assert.doesNotMatch(result.stdout, /fake-codebuddy:resume\b/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('passes resume --help through as a CodeBuddy --resume flag instead of printing top-level omb help', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-resume-cli-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodebuddyPath = join(fakeBin, 'codebuddy');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(fakeCodebuddyPath, '#!/bin/sh\nprintf \'fake-codebuddy:%s\\n\' \"$*\"\n');
      await chmod(fakeCodebuddyPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmb(wd, ['resume', '--help'], {
        HOME: home,
        PATH: fakeBin,
        OMB_AUTO_UPDATE: '0',
        OMB_NOTIFY_FALLBACK: '0',
        OMB_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codebuddy:--resume --help\b/);
      assert.doesNotMatch(result.stdout, /Unknown command: resume/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('uses CodeBuddy --resume form for resume when codex is unavailable', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-resume-cli-no-codex-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodebuddyPath = join(fakeBin, 'codebuddy');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(fakeCodebuddyPath, '#!/bin/sh\nprintf \'fake-codebuddy:%s\\n\' "$*"\n');
      await chmod(fakeCodebuddyPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmb(wd, ['resume', '--madmax'], {
        HOME: home,
        PATH: fakeBin,
        OMB_AUTO_UPDATE: '0',
        OMB_NOTIFY_FALLBACK: '0',
        OMB_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codebuddy:--resume --dangerously-skip-permissions\b/);
      assert.doesNotMatch(result.stdout, /fake-codex/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
