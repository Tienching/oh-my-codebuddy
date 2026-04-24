import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUD_TMUX_HEIGHT_LINES } from '../../hud/constants.js';

const CLI_SPAWN_TIMEOUT_MS = 15_000;

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
    timeout: CLI_SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
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

function shouldSkipForSpawnPermissions(err: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

describe('omb launch fallback when tmux is unavailable', () => {
  it('launches codebuddy directly without tmux ENOENT noise', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-launch-fallback-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodebuddyPath = join(fakeBin, 'codebuddy');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodebuddyPath,
        '#!/bin/sh\nprintf \'fake-codebuddy:%s\\n\' \"$*\"\n',
      );
      await chmod(fakeCodebuddyPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmb(
        wd,
        ['--xhigh', '--madmax'],
        {
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          OMB_AUTO_UPDATE: '0',
          OMB_NOTIFY_FALLBACK: '0',
          OMB_HOOK_DERIVED_SIGNALS: '0',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codebuddy:.*--dangerously-skip-permissions/);
      assert.match(result.stdout, /fake-codebuddy:.*--effort xhigh/);
      assert.doesNotMatch(result.stderr, /spawnSync tmux ENOENT/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('omb launcher when tmux is available', () => {
  it('launches --madmax through explicitly requested detached tmux so HUD bootstrap can run', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-launch-tmux-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodebuddyPath = join(fakeBin, 'codebuddy');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodebuddyPath,
        '#!/bin/sh\nprintf \'fake-codebuddy:%s\\n\' \"$*\"\n',
      );
      await chmod(fakeCodebuddyPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
  new-session)
    printf 'leader-pane\\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\\n'
    else
      printf '0\\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\\n'
    exit 0
    ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane)
    exit 0
    ;;
esac
exit 0
`,
      );
      await chmod(fakeTmuxPath, 0o755);

      const result = runOmb(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          OMB_AUTO_UPDATE: '0',
          OMB_NOTIFY_FALLBACK: '0',
          OMB_HOOK_DERIVED_SIGNALS: '0',
          TMUX: '',
          TMUX_PANE: '',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /tmux:new-session .* -s /);
      assert.match(tmuxLog, new RegExp(`tmux:split-window -v -l ${HUD_TMUX_HEIGHT_LINES} .* -t `));
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
