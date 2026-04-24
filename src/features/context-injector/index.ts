import {
  collectRepositoryContextSnapshot,
  summarizeRepositoryContext,
  type ContextInjectorGitRunner,
  type RepositoryContextSnapshot,
} from './collector.js';

export {
  collectRepositoryContextSnapshot,
  summarizeRepositoryContext,
} from './collector.js';
export type {
  ContextInjectorGitRunner,
  RepositoryContextSnapshot,
} from './collector.js';

export const OMB_PROVIDER_CONTEXT_INJECTION_ENV =
  'OMB_PROVIDER_CONTEXT_INJECTION';
export const OMB_EXPERIMENTAL_CONTEXT_INJECTOR_ENV =
  'OMB_EXPERIMENTAL_CONTEXT_INJECTOR';

export interface ContextInjectionResult {
  enabled: boolean;
  snapshot: RepositoryContextSnapshot | null;
  text: string | null;
}

function isTruthyFlag(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  );
}

export function isExperimentalContextInjectorEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isTruthyFlag(env[OMB_PROVIDER_CONTEXT_INJECTION_ENV]) ||
    isTruthyFlag(env[OMB_EXPERIMENTAL_CONTEXT_INJECTOR_ENV]) ||
    isTruthyFlag(env[OMB_EXPERIMENTAL_CONTEXT_INJECTOR_ENV])
  );
}

export async function maybeCollectContextInjection(
  cwd: string,
  options: {
    env?: NodeJS.ProcessEnv;
    gitRunner?: ContextInjectorGitRunner;
    preferredRemoteName?: string;
  } = {},
): Promise<ContextInjectionResult> {
  const env = options.env ?? process.env;
  if (!isExperimentalContextInjectorEnabled(env)) {
    return {
      enabled: false,
      snapshot: null,
      text: null,
    };
  }

  const snapshot = await collectRepositoryContextSnapshot(cwd, {
    gitRunner: options.gitRunner,
    preferredRemoteName: options.preferredRemoteName,
  });
  return {
    enabled: true,
    snapshot,
    text: summarizeRepositoryContext(snapshot),
  };
}
