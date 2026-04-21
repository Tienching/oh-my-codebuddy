import {
  classifySpawnError,
  spawnPlatformCommandSync,
  type ProbedPlatformCommand,
  type SpawnErrorKind,
} from '../utils/platform-command.js';
import {
  snapshotProcessEnvironment,
  type ProcessEnvironmentSnapshot,
} from './process-utils.js';

export type TmuxProbeStatus = 'available' | 'blocked' | 'error' | 'missing';

export interface PlatformRuntimeSnapshot extends ProcessEnvironmentSnapshot {
  degraded: boolean;
  degradedReasons: string[];
  tmuxAvailable: boolean;
  tmuxErrorKind: SpawnErrorKind | null;
  tmuxProbeStatus: TmuxProbeStatus;
}

export interface DetectPlatformRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readFileImpl?: typeof import('fs').readFileSync;
  spawnPlatformCommandSyncImpl?: (
    command: string,
    args: string[],
    options?: Parameters<typeof spawnPlatformCommandSync>[2],
    platform?: Parameters<typeof spawnPlatformCommandSync>[3],
    env?: Parameters<typeof spawnPlatformCommandSync>[4],
    existsImpl?: Parameters<typeof spawnPlatformCommandSync>[5],
    spawnImpl?: Parameters<typeof spawnPlatformCommandSync>[6],
  ) => ProbedPlatformCommand;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

function normalizeTmuxProbeStatus(errorKind: SpawnErrorKind | null): TmuxProbeStatus {
  if (errorKind === 'missing') return 'missing';
  if (errorKind === 'blocked') return 'blocked';
  if (errorKind === 'error') return 'error';
  return 'available';
}

export function detectPlatformRuntime(
  options: DetectPlatformRuntimeOptions = {},
): PlatformRuntimeSnapshot {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const spawnPlatformCommandSyncImpl =
    options.spawnPlatformCommandSyncImpl ?? spawnPlatformCommandSync;
  const processSnapshot = snapshotProcessEnvironment({
    env,
    platform,
    readFileImpl: options.readFileImpl,
    stdinIsTTY: options.stdinIsTTY,
    stdoutIsTTY: options.stdoutIsTTY,
  });

  const tmuxProbe = spawnPlatformCommandSyncImpl(
    'tmux',
    ['-V'],
    { encoding: 'utf-8' },
    platform,
    env,
  );
  const tmuxErrorKind = classifySpawnError(
    tmuxProbe.result.error as NodeJS.ErrnoException | undefined,
  );
  const tmuxAvailable =
    !tmuxProbe.result.error && tmuxProbe.result.status === 0;

  const degradedReasons: string[] = [];
  if (!processSnapshot.interactiveTerminal) {
    degradedReasons.push('non_interactive_terminal');
  }
  if (!tmuxAvailable) {
    degradedReasons.push(`tmux_${normalizeTmuxProbeStatus(tmuxErrorKind)}`);
  }
  if (processSnapshot.isNativeWindows) {
    degradedReasons.push('native_windows');
  }
  if (processSnapshot.insideTmux && !processSnapshot.tmuxPane) {
    degradedReasons.push('missing_tmux_pane');
  }

  return {
    ...processSnapshot,
    degraded: degradedReasons.length > 0,
    degradedReasons,
    tmuxAvailable,
    tmuxErrorKind,
    tmuxProbeStatus: normalizeTmuxProbeStatus(tmuxErrorKind),
  };
}

export function formatPlatformRuntime(
  snapshot: PlatformRuntimeSnapshot,
): string {
  const context = snapshot.insideTmux ? 'inside-tmux' : 'outside-tmux';
  const reasons =
    snapshot.degradedReasons.length > 0
      ? ` | reasons=${snapshot.degradedReasons.join(',')}`
      : '';
  return (
    `platform=${snapshot.platform}` +
    ` | interactive=${snapshot.interactiveTerminal ? 'yes' : 'no'}` +
    ` | tmux=${snapshot.tmuxAvailable ? 'available' : snapshot.tmuxProbeStatus}` +
    ` | context=${context}` +
    reasons
  );
}
