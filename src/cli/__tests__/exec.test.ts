import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
      OMB_MODEL_INSTRUCTIONS_FILE: '',
      OMB_TEAM_WORKER: '',
      OMB_TEAM_STATE_ROOT: '',
      OMB_TEAM_LEADER_CWD: '',
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

describe('omb exec', () => {
  it('runs CodeBuddy --print with session-scoped instructions that preserve AGENTS and overlay content', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-exec-cli-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodebuddyPath = join(fakeBin, 'codebuddy');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(join(home, '.codebuddy'), { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(home, '.codebuddy', 'AGENTS.md'), '# User Instructions\n\nGlobal guidance.\n');
      await writeFile(join(wd, 'AGENTS.md'), '# Project Instructions\n\nProject guidance.\n');
      await writeFile(
        fakeCodebuddyPath,
        [
          '#!/bin/sh',
          'printf \'fake-codebuddy:%s\\n\' "$*"',
          'while [ "$#" -gt 0 ]; do',
          '  case "$1" in',
          '    --system-prompt-file)',
          '      file="$2"',
          '      printf \'instructions-path:%s\\n\' "$file"',
          '      printf \'instructions-start\\n\'',
          '      cat "$file"',
          '      printf \'instructions-end\\n\'',
          '      shift 2',
          '      ;;',
          '    --system-prompt-file=*)',
          '      file=$(printf %s "$1" | sed \'s/^--system-prompt-file=//\')',
          '      printf \'instructions-path:%s\\n\' "$file"',
          '      printf \'instructions-start\\n\'',
          '      cat "$file"',
          '      printf \'instructions-end\\n\'',
          '      shift',
          '      ;;',
          '    *)',
          '      shift',
          '      ;;',
          '  esac',
          'done',
        ].join('\n'),
      );
      await chmod(fakeCodebuddyPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmb(wd, ['exec', '--model', 'gpt-5', 'say hi'], {
        HOME: home,
        CODEBUDDY_HOME: join(home, '.codebuddy'),
        NODE_OPTIONS: '',
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMB_AUTO_UPDATE: '0',
        OMB_NOTIFY_FALLBACK: '0',
        OMB_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codebuddy:--print --model gpt-5 say hi/);
      assert.match(result.stdout, /instructions-path:.*\/\.omb\/state\/sessions\/omb-.*\/AGENTS\.md/);
      assert.match(result.stdout, /# User Instructions/);
      assert.match(result.stdout, /# Project Instructions/);
      assert.match(result.stdout, /<!-- OMB:RUNTIME:START -->/);

      const sessionRoot = join(wd, '.omb', 'state', 'sessions');
      const sessionEntries = await readdir(sessionRoot);
      assert.equal(sessionEntries.length, 1);
      const sessionFiles = await readdir(join(sessionRoot, sessionEntries[0]));
      assert.equal(sessionFiles.includes('AGENTS.md'), false, 'session-scoped AGENTS file should be cleaned up after exec exits');
      assert.equal(existsSync(join(wd, '.omb', 'state', 'session.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('passes exec --help through to CodeBuddy --print', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-exec-help-'));
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

      const result = runOmb(wd, ['exec', '--help'], {
        HOME: home,
        CODEBUDDY_HOME: join(home, '.codebuddy'),
        NODE_OPTIONS: '',
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMB_AUTO_UPDATE: '0',
        OMB_NOTIFY_FALLBACK: '0',
        OMB_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codebuddy:--print --help\b/);
      assert.doesNotMatch(result.stdout, /oh-my-codebuddy \(omb\) - Multi-agent orchestration for CodeBuddy CLI/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('uses Codex exec subcommand and config injection when --leader-cli codex is selected', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-exec-codex-cli-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakeCodebuddyPath = join(fakeBin, 'codebuddy');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(join(home, '.codex'), { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), '# Project Instructions\n\nProject guidance.\n');
      await writeFile(fakeCodexPath, '#!/bin/sh\nprintf \'fake-codex:%s\\n\' "$*"\n');
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakeCodebuddyPath, '#!/bin/sh\nprintf \'fake-codebuddy:%s\\n\' "$*"\n');
      await chmod(fakeCodebuddyPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmb(wd, ['exec', '--leader-cli', 'codex', '--json', 'say hi'], {
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        NODE_OPTIONS: '',
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMB_AUTO_UPDATE: '0',
        OMB_NOTIFY_FALLBACK: '0',
        OMB_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:exec --json say hi -c model_instructions_file="/);
      assert.doesNotMatch(result.stdout, /fake-codebuddy/);
      assert.doesNotMatch(result.stdout, /--print\b/);
      assert.doesNotMatch(result.stdout, /--output-format\b/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
