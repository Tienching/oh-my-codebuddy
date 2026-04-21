import { homedir } from 'os';
import { join, relative } from 'path';
import {
  detectPlatformRuntime,
  formatPlatformRuntime,
  type DetectPlatformRuntimeOptions,
  type PlatformRuntimeSnapshot,
} from '../platform/index.js';

export const OMB_EXPERIMENTAL_PLATFORM_FACADE_ENV =
  'OMB_EXPERIMENTAL_PLATFORM_FACADE';
export const OMX_EXPERIMENTAL_PLATFORM_FACADE_ENV =
  'OMX_EXPERIMENTAL_PLATFORM_FACADE';
export const OMB_EXPERIMENTAL_INSTALLER_FACADE_ENV =
  'OMB_EXPERIMENTAL_INSTALLER_FACADE';
export const OMX_EXPERIMENTAL_INSTALLER_FACADE_ENV =
  'OMX_EXPERIMENTAL_INSTALLER_FACADE';

export type InstallerScope = 'user' | 'project';

export interface InstallerBackupContext {
  backupRoot: string;
  baseRoot: string;
}

export interface SetupRefreshRequest {
  force?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
}

export type SetupRefreshRunner<
  TRequest extends SetupRefreshRequest = SetupRefreshRequest,
> = (request?: TRequest) => Promise<void>;

export type { DetectPlatformRuntimeOptions, PlatformRuntimeSnapshot };

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

export function isExperimentalInstallerFacadeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isTruthyFlag(env[OMB_EXPERIMENTAL_PLATFORM_FACADE_ENV]) ||
    isTruthyFlag(env[OMX_EXPERIMENTAL_PLATFORM_FACADE_ENV]) ||
    isTruthyFlag(env[OMB_EXPERIMENTAL_INSTALLER_FACADE_ENV]) ||
    isTruthyFlag(env[OMX_EXPERIMENTAL_INSTALLER_FACADE_ENV])
  );
}

export function buildSetupBackupContext(
  scope: InstallerScope,
  projectRoot: string,
  timestamp = new Date(),
): InstallerBackupContext {
  const formattedTimestamp = timestamp.toISOString().replace(/[:]/g, '-');
  if (scope === 'project') {
    return {
      backupRoot: join(projectRoot, '.omb', 'backups', 'setup', formattedTimestamp),
      baseRoot: projectRoot,
    };
  }
  return {
    backupRoot: join(homedir(), '.codebuddy', 'backups', 'setup', formattedTimestamp),
    baseRoot: homedir(),
  };
}

export function resolveInstallerRelativePath(
  baseRoot: string,
  targetPath: string,
): string {
  const relativePath = relative(baseRoot, targetPath);
  return relativePath.startsWith('..') || relativePath === ''
    ? targetPath.replace(/^[/]+/, '')
    : relativePath;
}

export function detectInstallerRuntime(
  options: DetectPlatformRuntimeOptions = {},
): PlatformRuntimeSnapshot {
  return detectPlatformRuntime(options);
}

export async function runSetupRefresh<
  TRequest extends SetupRefreshRequest = SetupRefreshRequest,
>(
  runner: SetupRefreshRunner<TRequest>,
  request: TRequest,
  runtimeOptions: DetectPlatformRuntimeOptions = {},
): Promise<TRequest> {
  if (request.verbose) {
    console.log(
      `[omb] installer runtime: ${formatPlatformRuntime(
        detectInstallerRuntime(runtimeOptions),
      )}`,
    );
  }
  await runner(request);
  return request;
}
