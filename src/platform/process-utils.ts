import { readFileSync } from 'fs';

export interface ProcessEnvironmentSnapshot {
  interactiveTerminal: boolean;
  insideTmux: boolean;
  isMsysOrGitBash: boolean;
  isNativeWindows: boolean;
  isWsl2: boolean;
  platform: NodeJS.Platform;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  tmuxPane: string | null;
}

type ReadFileSyncLike = typeof readFileSync;

export function hasInteractiveTerminal(
  stdinIsTTY = process.stdin.isTTY,
  stdoutIsTTY = process.stdout.isTTY,
): boolean {
  return stdinIsTTY === true && stdoutIsTTY === true;
}

export function isMsysOrGitBash(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  const msystem = String(env.MSYSTEM ?? '').trim();
  if (msystem !== '') return true;
  const ostype = String(env.OSTYPE ?? '').trim();
  return /(msys|mingw|cygwin)/i.test(ostype);
}

export function isWsl2(
  env: NodeJS.ProcessEnv = process.env,
  readFileImpl: ReadFileSyncLike = readFileSync,
): boolean {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return true;
  }
  try {
    const version = readFileImpl('/proc/version', 'utf-8');
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
}

export function isNativeWindows(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readFileImpl: ReadFileSyncLike = readFileSync,
): boolean {
  return (
    platform === 'win32' &&
    !isWsl2(env, readFileImpl) &&
    !isMsysOrGitBash(env, platform)
  );
}

export function snapshotProcessEnvironment(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    readFileImpl?: ReadFileSyncLike;
    stdinIsTTY?: boolean;
    stdoutIsTTY?: boolean;
  } = {},
): ProcessEnvironmentSnapshot {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY ?? false;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY ?? false;
  const tmuxPane = String(env.TMUX_PANE ?? '').trim() || null;

  return {
    interactiveTerminal: hasInteractiveTerminal(stdinIsTTY, stdoutIsTTY),
    insideTmux: String(env.TMUX ?? '').trim() !== '',
    isMsysOrGitBash: isMsysOrGitBash(env, platform),
    isNativeWindows: isNativeWindows(env, platform, options.readFileImpl),
    isWsl2: isWsl2(env, options.readFileImpl),
    platform,
    stdinIsTTY,
    stdoutIsTTY,
    tmuxPane,
  };
}
