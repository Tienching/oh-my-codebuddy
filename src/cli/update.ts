/**
 * Launch-time update checks for oh-my-codebuddy.
 * Non-fatal and throttled; can be disabled via OMB_AUTO_UPDATE=0.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { getPackageRoot } from '../utils/package.js';
import { setup } from './setup.js';
import { runAutoUpdateFlow } from '../features/auto-update.js';
export {
  isNewerVersion,
  shouldCheckForUpdates,
} from '../features/auto-update.js';

interface LatestPackageInfo {
  version?: string;
}

const PACKAGE_NAME = 'oh-my-codebuddy';

async function fetchLatestVersion(timeoutMs = 3500): Promise<string | null> {
  const registryUrl = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(registryUrl, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json() as LatestPackageInfo;
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getCurrentVersion(): Promise<string | null> {
  try {
    const pkgPath = join(getPackageRoot(), 'package.json');
    const content = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function runGlobalUpdate(): { ok: boolean; stderr: string } {
  const result = spawnSync('npm', ['install', '-g', `${PACKAGE_NAME}@latest`], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 120000,
    windowsHide: true,
  });

  if (result.error) {
    return { ok: false, stderr: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || '').trim() || `npm exited ${result.status}` };
  }
  return { ok: true, stderr: '' };
}

async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

interface UpdateDependencies {
  askYesNo: typeof askYesNo;
  fetchLatestVersion: typeof fetchLatestVersion;
  getCurrentVersion: typeof getCurrentVersion;
  runGlobalUpdate: typeof runGlobalUpdate;
  setup: typeof setup;
}

const defaultUpdateDependencies: UpdateDependencies = {
  askYesNo,
  fetchLatestVersion,
  getCurrentVersion,
  runGlobalUpdate,
  setup,
};

export async function maybeCheckAndPromptUpdate(
  cwd: string,
  dependencies: Partial<UpdateDependencies> = {},
): Promise<void> {
  const updateDependencies = { ...defaultUpdateDependencies, ...dependencies };
  await runAutoUpdateFlow(cwd, {
    dependencies: {
      askYesNo: updateDependencies.askYesNo,
      fetchLatestVersion: updateDependencies.fetchLatestVersion,
      getCurrentVersion: updateDependencies.getCurrentVersion,
      runGlobalUpdate: updateDependencies.runGlobalUpdate,
      refreshSetup: updateDependencies.setup,
    },
  });
}
