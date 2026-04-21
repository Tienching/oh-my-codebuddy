/**
 * Shared AGENTS.md file lock for oh-my-codebuddy
 *
 * Unified lock implementation used by both agents-overlay.ts and
 * worker-bootstrap.ts to coordinate concurrent AGENTS.md access.
 *
 * Uses mkdir-based locking with PID-aware stale detection.
 */

import { readFile, writeFile, mkdir, rm, stat } from "fs/promises";
import { dirname, join } from "path";
import { existsSync } from "fs";

// ── Types ──────────────────────────────────────────────────────────────

export interface LockOwnerMeta {
  pid: number;
  session: string;
  module: string;
  ts: number;
}

export interface LockOptions {
  /** Absolute path to the lock directory. */
  lockPath: string;
  /** Metadata identifying the lock owner. */
  ownerMeta: { pid: number; session: string; module: string };
  /** Maximum time to wait for lock acquisition (default: 5000ms). */
  timeoutMs?: number;
  /** Age after which a lock is considered stale (default: 30000ms). */
  staleMs?: number;
  /** Interval between lock acquisition retries (default: 100ms). */
  pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const OWNER_FILE = "owner.json";

// ── Stale detection ────────────────────────────────────────────────────

async function isStaleLock(
  lockDir: string,
  staleMs: number,
): Promise<boolean> {
  const ownerFile = join(lockDir, OWNER_FILE);

  // Try PID-based detection first.
  try {
    const raw = await readFile(ownerFile, "utf-8");
    const owner = JSON.parse(raw) as { pid?: number; ts?: number };
    if (typeof owner.pid !== "number") return true;
    try {
      process.kill(owner.pid, 0);
    } catch {
      return true; // PID is dead → stale
    }
    return false;
  } catch {
    // Owner file missing or corrupt — fall back to mtime.
  }

  try {
    const lockStat = await stat(lockDir);
    return Date.now() - lockStat.mtimeMs > staleMs;
  } catch {
    return true;
  }
}

// ── Lock primitives ────────────────────────────────────────────────────

async function acquireLock(options: LockOptions): Promise<void> {
  const {
    lockPath,
    ownerMeta,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    staleMs = DEFAULT_STALE_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options;

  await mkdir(dirname(lockPath), { recursive: true });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await mkdir(lockPath, { recursive: false });

      const fullMeta: LockOwnerMeta = {
        pid: ownerMeta.pid,
        session: ownerMeta.session,
        module: ownerMeta.module,
        ts: Date.now(),
      };
      await writeFile(
        join(lockPath, OWNER_FILE),
        JSON.stringify(fullMeta),
        "utf-8",
      );
      return; // Lock acquired
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== "EEXIST") throw error;

      const stale = await isStaleLock(lockPath, staleMs);
      if (stale) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        continue; // Retry immediately after reaping stale lock
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  throw new Error(
    `Failed to acquire lock at ${lockPath} within ${timeoutMs}ms`,
  );
}

async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true }).catch(() => {});
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Execute a function while holding the AGENTS.md lock.
 * The lock is always released in a finally block.
 *
 * @param options - Lock configuration
 * @param fn - The function to execute under the lock
 * @returns The return value of `fn`
 * @throws If lock acquisition times out or `fn` throws
 */
export async function withAgentsLock<T>(
  options: LockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireLock(options);
  try {
    return await fn();
  } finally {
    await releaseLock(options.lockPath);
  }
}

/**
 * Resolve the standard lock path for a given working directory.
 * This is the canonical location: `{cwd}/.omb/state/agents-md.lock`
 */
export function resolveAgentsLockPath(cwd: string): string {
  return join(cwd, ".omb", "state", "agents-md.lock");
}

/**
 * Read lock owner metadata if a lock exists.
 * Returns null if no lock is held or the owner file is missing.
 */
export async function readLockOwner(
  lockPath: string,
): Promise<LockOwnerMeta | null> {
  const ownerFile = join(lockPath, OWNER_FILE);
  if (!existsSync(ownerFile)) return null;

  try {
    const raw = await readFile(ownerFile, "utf-8");
    return JSON.parse(raw) as LockOwnerMeta;
  } catch {
    return null;
  }
}
