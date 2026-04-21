export type RepositoryProviderId =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'gitea'
  | 'azure'
  | 'unknown';

export interface RepositoryProviderSnapshot {
  provider: RepositoryProviderId;
  canonicalHost: string;
  host: string;
  owner: string | null;
  project: string | null;
  repo: string | null;
  remoteName: string | null;
  remoteUrl: string;
  slug: string | null;
}

export interface RepositoryRemoteInput {
  name?: string | null;
  url: string;
}

export interface RepositoryProviderCollection {
  primary: RepositoryProviderSnapshot | null;
  remotes: RepositoryProviderSnapshot[];
}
