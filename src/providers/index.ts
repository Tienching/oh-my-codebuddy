import type {
  RepositoryProviderCollection,
  RepositoryProviderId,
  RepositoryProviderSnapshot,
  RepositoryRemoteInput,
} from './types.js';

export type {
  RepositoryProviderCollection,
  RepositoryProviderId,
  RepositoryProviderSnapshot,
  RepositoryRemoteInput,
} from './types.js';

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function trimGitSuffix(pathname: string): string {
  return pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
}

function buildSnapshot(
  provider: RepositoryProviderId,
  host: string,
  remoteUrl: string,
  remoteName: string | null,
  owner: string | null,
  repo: string | null,
  project: string | null = null,
): RepositoryProviderSnapshot {
  const slugParts = [owner, project, repo].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return {
    provider,
    canonicalHost: normalizeHost(host),
    host,
    owner,
    project,
    repo,
    remoteName,
    remoteUrl,
    slug: slugParts.length > 0 ? slugParts.join('/') : null,
  };
}

function inferProviderFromHost(host: string): RepositoryProviderId {
  const normalizedHost = normalizeHost(host);
  if (normalizedHost === 'github.com') return 'github';
  if (normalizedHost === 'gitlab.com') return 'gitlab';
  if (normalizedHost === 'bitbucket.org') return 'bitbucket';
  if (
    normalizedHost === 'dev.azure.com' ||
    normalizedHost === 'ssh.dev.azure.com' ||
    normalizedHost.endsWith('.visualstudio.com')
  ) {
    return 'azure';
  }
  if (normalizedHost.includes('gitea')) return 'gitea';
  return 'unknown';
}

function parseAzureSnapshot(
  host: string,
  remoteUrl: string,
  remoteName: string | null,
  pathname: string,
): RepositoryProviderSnapshot | null {
  const cleanPath = trimGitSuffix(pathname).replace(/^\/+/, '');
  const sshMatch = cleanPath.match(/^v3\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (sshMatch) {
    return buildSnapshot(
      'azure',
      host,
      remoteUrl,
      remoteName,
      sshMatch[1],
      sshMatch[3],
      sshMatch[2],
    );
  }

  const devOpsMatch = cleanPath.match(/^([^/]+)\/([^/]+)\/_git\/([^/]+)$/);
  if (devOpsMatch) {
    return buildSnapshot(
      'azure',
      host,
      remoteUrl,
      remoteName,
      devOpsMatch[1],
      devOpsMatch[3],
      devOpsMatch[2],
    );
  }

  return buildSnapshot('azure', host, remoteUrl, remoteName, null, null, null);
}

function parseStandardSnapshot(
  provider: RepositoryProviderId,
  host: string,
  remoteUrl: string,
  remoteName: string | null,
  pathname: string,
): RepositoryProviderSnapshot {
  const cleanPath = trimGitSuffix(pathname).replace(/^\/+/, '');
  const segments = cleanPath.split('/').filter(Boolean);
  const repo = segments.length > 0 ? segments[segments.length - 1] : null;
  const owner =
    segments.length > 1 ? segments.slice(0, segments.length - 1).join('/') : null;
  return buildSnapshot(provider, host, remoteUrl, remoteName, owner, repo);
}

function parseSshLikeRemote(
  remoteUrl: string,
  remoteName: string | null,
): RepositoryProviderSnapshot | null {
  if (remoteUrl.includes('://')) return null;
  const sshLikeMatch = remoteUrl.trim().match(/^(?:([^@]+)@)?([^:]+):(.+)$/);
  if (!sshLikeMatch) return null;

  const host = sshLikeMatch[2];
  const pathname = sshLikeMatch[3];
  const provider = inferProviderFromHost(host);
  if (provider === 'azure') {
    return parseAzureSnapshot(host, remoteUrl, remoteName, pathname);
  }
  if (provider === 'unknown') {
    return parseStandardSnapshot('gitea', host, remoteUrl, remoteName, pathname);
  }
  return parseStandardSnapshot(provider, host, remoteUrl, remoteName, pathname);
}

export function parseRepositoryRemote(
  remote: RepositoryRemoteInput,
): RepositoryProviderSnapshot {
  const remoteUrl = remote.url.trim();
  const remoteName = remote.name?.trim() || null;
  if (!remoteUrl) {
    return buildSnapshot('unknown', '', remoteUrl, remoteName, null, null, null);
  }

  try {
    const parsed = new URL(remoteUrl);
    const host = parsed.hostname;
    const provider = inferProviderFromHost(host);
    if (provider === 'azure') {
      return parseAzureSnapshot(host, remoteUrl, remoteName, parsed.pathname) ??
        buildSnapshot('azure', host, remoteUrl, remoteName, null, null, null);
    }
    if (provider === 'unknown') {
      return parseStandardSnapshot('gitea', host, remoteUrl, remoteName, parsed.pathname);
    }
    return parseStandardSnapshot(
      provider,
      host,
      remoteUrl,
      remoteName,
      parsed.pathname,
    );
  } catch {
    const sshLikeSnapshot = parseSshLikeRemote(remoteUrl, remoteName);
    if (sshLikeSnapshot) return sshLikeSnapshot;
    return buildSnapshot('unknown', '', remoteUrl, remoteName, null, null, null);
  }
}

export function selectPrimaryRepositoryProvider(
  remotes: readonly RepositoryProviderSnapshot[],
  preferredRemoteName = 'origin',
): RepositoryProviderSnapshot | null {
  if (remotes.length === 0) return null;
  const preferred =
    remotes.find((remote) => remote.remoteName === preferredRemoteName) ??
    remotes.find((remote) => remote.provider !== 'unknown') ??
    remotes[0];
  return preferred ?? null;
}

export function collectRepositoryProviders(
  remotes: readonly RepositoryRemoteInput[],
  preferredRemoteName = 'origin',
): RepositoryProviderCollection {
  const snapshots = remotes.map((remote) => parseRepositoryRemote(remote));
  return {
    primary: selectPrimaryRepositoryProvider(snapshots, preferredRemoteName),
    remotes: snapshots,
  };
}
