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

async function writeFakeCli(binDir: string, name: 'codebuddy' | 'codex' | 'claude'): Promise<void> {
  const path = join(binDir, name);
  await writeFile(path, `#!/bin/sh\nprintf 'fake-${name}:%s\\n' "$*"\n`);
  await chmod(path, 0o755);
}

async function writeFakePs(binDir: string): Promise<void> {
  const fakePsPath = join(binDir, 'ps');
  await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
  await chmod(fakePsPath, 0o755);
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
        OMB_LEADER_CLI: '',
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
        OMB_LEADER_CLI: '',
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
        OMB_LEADER_CLI: '',
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

  it('uses Codex resume subcommand when --leader-cli codex is selected', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-resume-cli-codex-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFakeCli(fakeBin, 'codex');
      await writeFakeCli(fakeBin, 'codebuddy');
      await writeFakePs(fakeBin);

      const result = runOmb(wd, ['resume', '--leader-cli', 'codex', '--last'], {
        HOME: home,
        PATH: fakeBin,
        OMB_AUTO_UPDATE: '0',
        OMB_NOTIFY_FALLBACK: '0',
        OMB_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume --last\b/);
      assert.match(result.stdout, /-c model_instructions_file="/);
      assert.doesNotMatch(result.stdout, /fake-codebuddy/);
      assert.doesNotMatch(result.stdout, /--continue\b/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('restores the active leader CLI from session state when --leader-cli is omitted', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-resume-session-cli-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const stateDir = join(wd, '.omb', 'state');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFakeCli(fakeBin, 'codex');
      await writeFakeCli(fakeBin, 'codebuddy');
      await writeFakePs(fakeBin);
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: 'sess-active',
        started_at: '2026-05-13T00:00:00.000Z',
        cwd: wd,
        pid: 123,
        leader_cli: 'codex',
      }, null, 2));

      const result = runOmb(wd, ['resume', '--last'], {
        HOME: home,
        PATH: fakeBin,
        OMB_LEADER_CLI: '',
        OMB_AUTO_UPDATE: '0',
        OMB_NOTIFY_FALLBACK: '0',
        OMB_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume --last\b/);
      assert.doesNotMatch(result.stdout, /fake-codebuddy/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('restores the most recent ended leader CLI from session history when active session state is absent', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-resume-history-cli-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const logsDir = join(wd, '.omb', 'logs');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await writeFakeCli(fakeBin, 'claude');
      await writeFakeCli(fakeBin, 'codebuddy');
      await writeFakePs(fakeBin);
      await writeFile(join(logsDir, 'session-history.jsonl'), [
        JSON.stringify({ session_id: 'sess-old', ended_at: '2026-05-12T00:00:00.000Z', leader_cli: 'codex' }),
        JSON.stringify({ session_id: 'sess-new', ended_at: '2026-05-13T00:00:00.000Z', leader_cli: 'claude' }),
      ].join('\n'));

      const result = runOmb(wd, ['resume'], {
        HOME: home,
        PATH: fakeBin,
        OMB_LEADER_CLI: '',
        OMB_AUTO_UPDATE: '0',
        OMB_NOTIFY_FALLBACK: '0',
        OMB_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-claude:--resume\b/);
      assert.doesNotMatch(result.stdout, /fake-codebuddy/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prefers explicit and env leader CLI values over persisted defaults', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-resume-precedence-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const stateDir = join(wd, '.omb', 'state');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFakeCli(fakeBin, 'claude');
      await writeFakeCli(fakeBin, 'codex');
      await writeFakeCli(fakeBin, 'codebuddy');
      await writeFakePs(fakeBin);
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: 'sess-active',
        started_at: '2026-05-13T00:00:00.000Z',
        cwd: wd,
        pid: 123,
        leader_cli: 'codex',
      }, null, 2));

      const explicitResult = runOmb(wd, ['resume', '--leader-cli', 'claude'], {
        HOME: home,
        PATH: fakeBin,
        OMB_AUTO_UPDATE: '0',
        OMB_NOTIFY_FALLBACK: '0',
        OMB_HOOK_DERIVED_SIGNALS: '0',
      });
      assert.equal(explicitResult.status, 0, explicitResult.error || explicitResult.stderr || explicitResult.stdout);
      assert.match(explicitResult.stdout, /fake-claude:--resume\b/);
      assert.doesNotMatch(explicitResult.stdout, /fake-codex/);

      const envResult = runOmb(wd, ['resume'], {
        HOME: home,
        PATH: fakeBin,
        OMB_LEADER_CLI: 'claude',
        OMB_AUTO_UPDATE: '0',
        OMB_NOTIFY_FALLBACK: '0',
        OMB_HOOK_DERIVED_SIGNALS: '0',
      });
      assert.equal(envResult.status, 0, envResult.error || envResult.stderr || envResult.stdout);
      assert.match(envResult.stdout, /fake-claude:--resume\b/);
      assert.doesNotMatch(envResult.stdout, /fake-codex/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('falls back to the setup provider when no recent leader CLI is persisted', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-resume-setup-provider-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const ombDir = join(wd, '.omb');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(ombDir, { recursive: true });
      await writeFakeCli(fakeBin, 'claude');
      await writeFakeCli(fakeBin, 'codebuddy');
      await writeFakePs(fakeBin);
      await writeFile(join(ombDir, 'setup-scope.json'), JSON.stringify({ provider: 'claude', scope: 'project' }, null, 2));

      const result = runOmb(wd, ['resume'], {
        HOME: home,
        PATH: fakeBin,
        OMB_LEADER_CLI: '',
        OMB_AUTO_UPDATE: '0',
        OMB_NOTIFY_FALLBACK: '0',
        OMB_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-claude:--resume\b/);
      assert.doesNotMatch(result.stdout, /fake-codebuddy/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
