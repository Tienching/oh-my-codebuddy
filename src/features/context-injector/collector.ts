import { spawnSync } from 'child_process';
import { collectRepositoryProviders } from '../../providers/index.js';
import type {
  RepositoryProviderCollection,
  RepositoryProviderSnapshot,
} from '../../providers/types.js';

export type ContextInjectorGitRunner = (
  cwd: string,
  args: string[],
) => string | Promise<string | null> | null;

export interface RepositoryContextSnapshot extends RepositoryProviderCollection {
  preferredRemoteName: string;
}

function defaultGitRunner(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const stdout = (result.stdout || '').trim();
  return stdout.length > 0 ? stdout : null;
}

async function runGitCommand(
  cwd: string,
  args: string[],
  gitRunner: ContextInjectorGitRunner,
): Promise<string | null> {
  const output = await gitRunner(cwd, args);
  if (typeof output !== 'string') return null;
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function collectRepositoryContextSnapshot(
  cwd: string,
  options: {
    gitRunner?: ContextInjectorGitRunner;
    preferredRemoteName?: string;
  } = {},
): Promise<RepositoryContextSnapshot> {
  const gitRunner = options.gitRunner ?? defaultGitRunner;
  const preferredRemoteName = options.preferredRemoteName ?? 'origin';

  const remoteNamesOutput = await runGitCommand(cwd, ['remote'], gitRunner);
  const remoteNames = (remoteNamesOutput ?? '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  const orderedRemoteNames = [
    preferredRemoteName,
    ...remoteNames.filter((remoteName) => remoteName !== preferredRemoteName),
  ];

  const remotes: Array<{ name: string; url: string }> = [];
  for (const remoteName of orderedRemoteNames) {
    const remoteUrl = await runGitCommand(
      cwd,
      ['remote', 'get-url', remoteName],
      gitRunner,
    );
    if (!remoteUrl) continue;
    remotes.push({ name: remoteName, url: remoteUrl });
  }

  return {
    ...collectRepositoryProviders(remotes, preferredRemoteName),
    preferredRemoteName,
  };
}

export function summarizeRepositoryContext(
  snapshot: RepositoryContextSnapshot,
): string | null {
  const primaryProvider = snapshot.primary;
  if (!primaryProvider) return null;

  const label = describeProvider(primaryProvider);
  return `Repository provider: ${label}`;
}

function describeProvider(snapshot: RepositoryProviderSnapshot): string {
  const remoteName = snapshot.remoteName ? ` via ${snapshot.remoteName}` : '';
  if (snapshot.slug) {
    return `${snapshot.provider}:${snapshot.slug}${remoteName}`;
  }
  if (snapshot.host) {
    return `${snapshot.provider}:${snapshot.host}${remoteName}`;
  }
  return `${snapshot.provider}${remoteName}`;
}
