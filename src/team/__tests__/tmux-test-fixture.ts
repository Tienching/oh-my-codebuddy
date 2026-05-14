import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface TmuxEnvSnapshot {
  TMUX?: string;
  TMUX_PANE?: string;
}

export interface TempTmuxSessionFixture {
  sessionName: string;
  serverName: string;
  windowTarget: string;
  leaderPaneId: string;
  socketPath: string;
  serverKind: 'ambient' | 'synthetic';
  env: {
    TMUX: string;
    TMUX_PANE: string;
  };
  sessionExists: (targetSessionName?: string) => boolean;
}

export interface TempTmuxSessionOptions {
  useAmbientServer?: boolean;
}

function snapshotTmuxEnv(source: NodeJS.ProcessEnv = process.env): TmuxEnvSnapshot {
  return {
    TMUX: typeof source.TMUX === 'string' ? source.TMUX : undefined,
    TMUX_PANE: typeof source.TMUX_PANE === 'string' ? source.TMUX_PANE : undefined,
  };
}

function applyTmuxEnv(snapshot: TmuxEnvSnapshot): void {
  if (typeof snapshot.TMUX === 'string') process.env.TMUX = snapshot.TMUX;
  else delete process.env.TMUX;

  if (typeof snapshot.TMUX_PANE === 'string') process.env.TMUX_PANE = snapshot.TMUX_PANE;
  else delete process.env.TMUX_PANE;
}

function runTmux(
  args: string[],
  options: { ignoreTmuxEnv?: boolean; env?: NodeJS.ProcessEnv; serverName?: string; tmuxTmpdir?: string } = {},
): string {
  let env: NodeJS.ProcessEnv = options.env
    ?? (options.ignoreTmuxEnv ? { ...process.env, TMUX: undefined, TMUX_PANE: undefined } : process.env);
  // Isolate fixture sockets into a dedicated TMUX_TMPDIR so they don't pollute
  // (or get poisoned by) the shared /tmp/tmux-{uid}/ directory used by the
  // user's interactive tmux server.
  if (options.tmuxTmpdir) {
    env = { ...env, TMUX_TMPDIR: options.tmuxTmpdir };
  }
  const argv = options.serverName ? ['-L', options.serverName, ...args] : args;
  const result = spawnSync('tmux', argv, {
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || '').trim() || `tmux exited ${result.status}`);
  }
  return (result.stdout || '').trim();
}

export function isRealTmuxAvailable(): boolean {
  try {
    runTmux(['-V'], { ignoreTmuxEnv: true });
    return true;
  } catch {
    return false;
  }
}

export function tmuxSessionExists(sessionName: string, serverName?: string, tmuxTmpdir?: string): boolean {
  try {
    runTmux(['has-session', '-t', sessionName], {
      ignoreTmuxEnv: true,
      serverName,
      tmuxTmpdir,
    });
    return true;
  } catch {
    return false;
  }
}

function uniqueTmuxIdentifier(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function withTempTmuxSession<T>(
  optionsOrFn: TempTmuxSessionOptions | ((fixture: TempTmuxSessionFixture) => Promise<T> | T),
  maybeFn?: (fixture: TempTmuxSessionFixture) => Promise<T> | T,
): Promise<T> {
  if (!isRealTmuxAvailable()) {
    throw new Error('tmux is not available');
  }

  const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  if (!fn) {
    throw new Error('withTempTmuxSession requires a callback');
  }

  const previousEnv = snapshotTmuxEnv(process.env);
  const fixtureCwd = await mkdtemp(join(tmpdir(), 'omb-tmux-fixture-'));
  // Per-fixture TMUX_TMPDIR — socket files land under this dir (not the
  // user's shared /tmp/tmux-{uid}/), so an abnormal teardown cannot leak
  // sockets into the interactive server's directory and the rm below
  // sweeps everything atomically. Only used for synthetic servers; ambient
  // mode intentionally shares the user's TMUX_TMPDIR.
  const fixtureSocketDir = options.useAmbientServer
    ? null
    : await mkdtemp(join(tmpdir(), 'omb-tmux-sock-'));
  const sessionName = uniqueTmuxIdentifier('omb-test');
  const serverName = options.useAmbientServer ? '' : uniqueTmuxIdentifier('omb-fixture');
  const serverKind: TempTmuxSessionFixture['serverKind'] = options.useAmbientServer ? 'ambient' : 'synthetic';
  const tmuxOptions = {
    ignoreTmuxEnv: true,
    serverName: serverName || undefined,
    tmuxTmpdir: fixtureSocketDir || undefined,
  } as const;

  const created = runTmux([
    'new-session',
    '-d',
    '-P',
    '-F',
    '#{session_name}:#{window_index} #{pane_id}',
    '-s',
    sessionName,
    '-c',
    fixtureCwd,
    'sleep 300',
  ], tmuxOptions);
  const [windowTarget = '', leaderPaneId = ''] = created.split(/\s+/, 2);
  if (windowTarget === '' || leaderPaneId === '') {
    try {
      if (serverKind === 'synthetic') {
        runTmux(['kill-server'], tmuxOptions);
      } else {
        runTmux(['kill-session', '-t', sessionName], tmuxOptions);
      }
    } catch {}
    await rm(fixtureCwd, { recursive: true, force: true });
    if (fixtureSocketDir) await rm(fixtureSocketDir, { recursive: true, force: true });
    throw new Error(`failed to create temporary tmux fixture: ${created}`);
  }

  const socketPath = runTmux(['display-message', '-p', '-t', leaderPaneId, '#{socket_path}'], tmuxOptions);
  process.env.TMUX = `${socketPath},${process.pid},0`;
  process.env.TMUX_PANE = leaderPaneId;

  const fixture: TempTmuxSessionFixture = {
    sessionName,
    serverName,
    windowTarget,
    leaderPaneId,
    socketPath,
    serverKind,
    env: {
      TMUX: process.env.TMUX,
      TMUX_PANE: leaderPaneId,
    },
    sessionExists: (targetSessionName = sessionName) =>
      tmuxSessionExists(targetSessionName, serverName || undefined, fixtureSocketDir || undefined),
  };

  try {
    return await fn(fixture);
  } finally {
    try {
      if (serverKind === 'synthetic') {
        runTmux(['kill-server'], tmuxOptions);
      } else {
        runTmux(['kill-session', '-t', sessionName], tmuxOptions);
      }
    } catch {}
    applyTmuxEnv(previousEnv);
    await rm(fixtureCwd, { recursive: true, force: true });
    // Sweep the per-fixture socket dir last — this also cleans up socket
    // files left behind by a tmux server that exited abnormally.
    if (fixtureSocketDir) await rm(fixtureSocketDir, { recursive: true, force: true });
  }
}
