import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  isExperimentalInstallerFacadeEnabled,
  runSetupRefresh,
  type SetupRefreshRequest,
} from '../installer/index.js';
import { detectPlatformRuntime } from '../platform/index.js';

export interface UpdateState {
  last_checked_at: string;
  last_seen_latest?: string;
}

export interface AutoUpdateRunResult {
  ok: boolean;
  stderr: string;
}

export interface AutoUpdateDependencies<
  TSetupRefreshRequest extends SetupRefreshRequest = SetupRefreshRequest,
> {
  askYesNo: (question: string) => Promise<boolean>;
  fetchLatestVersion: () => Promise<string | null>;
  getCurrentVersion: () => Promise<string | null>;
  runGlobalUpdate: () => AutoUpdateRunResult;
  refreshSetup: (options?: TSetupRefreshRequest) => Promise<void>;
}

export interface AutoUpdateOptions<
  TSetupRefreshRequest extends SetupRefreshRequest = SetupRefreshRequest,
> {
  dependencies: AutoUpdateDependencies<TSetupRefreshRequest>;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  nowMs?: number;
  setupRefreshRequest?: TSetupRefreshRequest;
}

const PACKAGE_NAME = 'oh-my-codebuddy';
export const AUTO_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

function parseSemver(version: string): [number, number, number] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerVersion(current: string, latest: string): boolean {
  const parsedCurrent = parseSemver(current);
  const parsedLatest = parseSemver(latest);
  if (!parsedCurrent || !parsedLatest) return false;
  if (parsedLatest[0] !== parsedCurrent[0]) {
    return parsedLatest[0] > parsedCurrent[0];
  }
  if (parsedLatest[1] !== parsedCurrent[1]) {
    return parsedLatest[1] > parsedCurrent[1];
  }
  return parsedLatest[2] > parsedCurrent[2];
}

export function shouldCheckForUpdates(
  nowMs: number,
  state: UpdateState | null,
  intervalMs = AUTO_UPDATE_CHECK_INTERVAL_MS,
): boolean {
  if (!state?.last_checked_at) return true;
  const lastCheckedAt = Date.parse(state.last_checked_at);
  if (!Number.isFinite(lastCheckedAt)) return true;
  return nowMs - lastCheckedAt >= intervalMs;
}

export function updateStatePath(cwd: string): string {
  return join(cwd, '.omb', 'state', 'update-check.json');
}

export async function readUpdateState(cwd: string): Promise<UpdateState | null> {
  const statePath = updateStatePath(cwd);
  if (!existsSync(statePath)) return null;
  try {
    const content = await readFile(statePath, 'utf-8');
    return JSON.parse(content) as UpdateState;
  } catch {
    return null;
  }
}

export async function writeUpdateState(
  cwd: string,
  state: UpdateState,
): Promise<void> {
  const stateDir = join(cwd, '.omb', 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(updateStatePath(cwd), JSON.stringify(state, null, 2));
}

export async function runAutoUpdateFlow<
  TSetupRefreshRequest extends SetupRefreshRequest = SetupRefreshRequest,
>(
  cwd: string,
  options: AutoUpdateOptions<TSetupRefreshRequest>,
): Promise<void> {
  const {
    dependencies,
    dryRun = false,
    env = process.env,
    intervalMs = AUTO_UPDATE_CHECK_INTERVAL_MS,
    nowMs = Date.now(),
  } = options;

  const runtime = detectPlatformRuntime({
    env,
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
  });

  if (env.OMB_AUTO_UPDATE === '0') return;
  if (!runtime.interactiveTerminal) return;

  const state = await readUpdateState(cwd);
  if (!shouldCheckForUpdates(nowMs, state, intervalMs)) return;

  const [currentVersion, latestVersion] = await Promise.all([
    dependencies.getCurrentVersion(),
    dependencies.fetchLatestVersion(),
  ]);

  await writeUpdateState(cwd, {
    last_checked_at: new Date(nowMs).toISOString(),
    last_seen_latest: latestVersion || state?.last_seen_latest,
  });

  if (
    !currentVersion ||
    !latestVersion ||
    !isNewerVersion(currentVersion, latestVersion)
  ) {
    return;
  }

  const approved = await dependencies.askYesNo(
    `[omb] Update available: v${currentVersion} → v${latestVersion}. Update now? [Y/n] `,
  );
  if (!approved) return;

  const setupRefreshRequest = (options.setupRefreshRequest ??
    ({ force: true } as TSetupRefreshRequest)) as TSetupRefreshRequest;

  if (dryRun) {
    console.log(
      `[omb] Dry run: would run npm install -g ${PACKAGE_NAME}@latest and refresh setup.`,
    );
    return;
  }

  console.log(`[omb] Running: npm install -g ${PACKAGE_NAME}@latest`);
  const result = dependencies.runGlobalUpdate();

  if (!result.ok) {
    console.log(
      '[omb] Update failed. Run manually: npm install -g oh-my-codebuddy@latest',
    );
    return;
  }

  if (isExperimentalInstallerFacadeEnabled(env)) {
    await runSetupRefresh(dependencies.refreshSetup, setupRefreshRequest, {
      env,
      stdinIsTTY: runtime.stdinIsTTY,
      stdoutIsTTY: runtime.stdoutIsTTY,
    });
  } else {
    await dependencies.refreshSetup(setupRefreshRequest);
  }
  console.log(`[omb] Updated to v${latestVersion}. Restart to use new code.`);
}
