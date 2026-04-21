/**
 * Worker Restart - Exponential backoff restart tracking for unhealthy workers
 *
 * Persists per-worker restart state and provides shouldRestart/recordRestart
 * functions with configurable backoff policy. After maxRestarts attempts,
 * the worker is considered exhausted and no further restarts are allowed
 * until manual intervention or successful recovery clears the state.
 *
 */

import { existsSync } from "fs";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { join } from "path";

// ── Types ──────────────────────────────────────────────────────────────

export interface RestartPolicy {
  /** Maximum restart attempts before giving up. Default: 3 */
  maxRestarts: number;
  /** Base backoff delay in ms. Default: 5000 */
  backoffBaseMs: number;
  /** Maximum backoff delay in ms. Default: 60000 */
  backoffMaxMs: number;
  /** Backoff multiplier. Default: 2 */
  backoffMultiplier: number;
}

export interface RestartState {
  workerName: string;
  restartCount: number;
  lastRestartAt: string;
  nextBackoffMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  maxRestarts: 3,
  backoffBaseMs: 5000,
  backoffMaxMs: 60000,
  backoffMultiplier: 2,
};

// ── Path helpers ───────────────────────────────────────────────────────

function teamBridgeDir(cwd: string, teamName: string): string {
  return join(cwd, ".omb", "state", "team-bridge", teamName);
}

function restartStatePath(
  cwd: string,
  teamName: string,
  workerName: string,
): string {
  return join(teamBridgeDir(cwd, teamName), `${workerName}.restart.json`);
}

// ── State I/O ─────────────────────────────────────────────────────────

/** Read the restart state for a worker. Returns null if none exists. */
export async function readRestartState(
  cwd: string,
  teamName: string,
  workerName: string,
): Promise<RestartState | null> {
  const path = restartStatePath(cwd, teamName, workerName);
  try {
    if (!existsSync(path)) return null;
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as RestartState;
  } catch {
    return null;
  }
}

/**
 * Returns the backoff delay in ms if a restart is allowed,
 * or null if the worker has exhausted its restart budget.
 */
export async function shouldRestart(
  cwd: string,
  teamName: string,
  workerName: string,
  policy: RestartPolicy = DEFAULT_RESTART_POLICY,
): Promise<number | null> {
  const state = await readRestartState(cwd, teamName, workerName);
  const count = state?.restartCount ?? 0;

  if (count >= policy.maxRestarts) {
    return null; // Exhausted
  }

  const backoffMs = Math.min(
    policy.backoffBaseMs * Math.pow(policy.backoffMultiplier, count),
    policy.backoffMaxMs,
  );

  return backoffMs;
}

/**
 * Record a restart attempt for the worker.
 * Increments the restart count and writes updated state.
 */
export async function recordRestart(
  cwd: string,
  teamName: string,
  workerName: string,
  policy: RestartPolicy = DEFAULT_RESTART_POLICY,
): Promise<RestartState> {
  const prev = await readRestartState(cwd, teamName, workerName);
  const count = (prev?.restartCount ?? 0) + 1;
  const nextBackoffMs = Math.min(
    policy.backoffBaseMs * Math.pow(policy.backoffMultiplier, count),
    policy.backoffMaxMs,
  );

  const state: RestartState = {
    workerName,
    restartCount: count,
    lastRestartAt: new Date().toISOString(),
    nextBackoffMs,
  };

  const dir = teamBridgeDir(cwd, teamName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    restartStatePath(cwd, teamName, workerName),
    JSON.stringify(state, null, 2) + "\n",
  );

  return state;
}

/**
 * Clear restart state after successful recovery.
 * Removes the sidecar file so the worker gets a fresh restart budget.
 */
export async function clearRestartState(
  cwd: string,
  teamName: string,
  workerName: string,
): Promise<void> {
  const path = restartStatePath(cwd, teamName, workerName);
  try {
    if (existsSync(path)) {
      await unlink(path);
    }
  } catch {
    // Ignore — state may already be removed
  }
}

/**
 * Compute the backoff delay for a given restart count.
 * Useful for display/logging without actually recording a restart.
 */
export function computeBackoffDelay(
  restartCount: number,
  policy: RestartPolicy = DEFAULT_RESTART_POLICY,
): number {
  return Math.min(
    policy.backoffBaseMs * Math.pow(policy.backoffMultiplier, restartCount),
    policy.backoffMaxMs,
  );
}
