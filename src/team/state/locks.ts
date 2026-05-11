import { existsSync } from 'fs';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, sep } from 'path';

function mirrorLockDir(lockDir: string): string | null {
  const canonicalSegment = `${sep}.omb${sep}state${sep}`;
  const legacySegment = `${sep}.omb${sep}state${sep}`;
  if (lockDir.includes(canonicalSegment)) {
    return lockDir.replace(canonicalSegment, legacySegment);
  }
  if (lockDir.includes(legacySegment)) {
    return lockDir.replace(legacySegment, canonicalSegment);
  }
  return null;
}

interface TeamPathDeps {
  teamDir: (teamName: string, cwd: string) => string;
  taskClaimLockDir: (teamName: string, taskId: string, cwd: string) => string;
  mailboxLockDir: (teamName: string, workerName: string, cwd: string) => string;
}

const LOCK_OWNER_RETRY_MS = 25;

function lockOwnerToken(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

async function maybeRecoverStaleLock(lockDir: string, lockStaleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    const ageMs = Date.now() - info.mtimeMs;
    if (ageMs > lockStaleMs) {
      await rm(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withScalingLock<T>(
  teamName: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = join(deps.teamDir(teamName, cwd), '.lock.scaling');
  const mirrorDir = mirrorLockDir(lockDir);
  const activeLockDirs = [lockDir, ...(mirrorDir && mirrorDir !== lockDir ? [mirrorDir] : [])];
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + 10_000;
  await mkdir(dirname(lockDir), { recursive: true });
  while (true) {
    try {
      for (const dir of activeLockDirs) {
        await mkdir(dirname(dir), { recursive: true });
      }
      await mkdir(lockDir);
      for (const dir of activeLockDirs.slice(1)) {
        await mkdir(dir, { recursive: true });
      }
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await Promise.all(activeLockDirs.map((dir) => rm(dir, { recursive: true, force: true })));
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, lockStaleMs)) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring scaling lock for team ${teamName}`);
      }
      await sleep(50);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await Promise.all(activeLockDirs.map((dir) => rm(dir, { recursive: true, force: true })));
      }
    } catch {
    }
  }
}

export async function withTeamLock<T>(
  teamName: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = join(deps.teamDir(teamName, cwd), '.lock.create-task');
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, lockStaleMs)) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring team task lock for ${teamName}`);
      }
      await sleep(LOCK_OWNER_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}

export async function withTaskClaimLock<T>(
  teamName: string,
  taskId: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const lockDir = deps.taskClaimLockDir(teamName, taskId, cwd);
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, lockStaleMs)) continue;
      if (Date.now() > deadline) return { ok: false };
      await sleep(LOCK_OWNER_RETRY_MS);
    }
  }

  try {
    await writeFile(ownerPath, ownerToken, 'utf8');
    return { ok: true, value: await fn() };
  } catch (error) {
    await rm(lockDir, { recursive: true, force: true });
    throw error;
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}

export async function withMailboxLock<T>(
  teamName: string,
  workerName: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  fn: () => Promise<T>,
): Promise<T> {
  const root = deps.teamDir(teamName, cwd);
  if (!existsSync(root)) {
    throw new Error(`Team ${teamName} not found`);
  }
  const lockDir = deps.mailboxLockDir(teamName, workerName, cwd);
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + 5000;
  await mkdir(dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, lockStaleMs)) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring mailbox lock for ${teamName}/${workerName}`);
      }
      await sleep(LOCK_OWNER_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}

/**
 * File-based lock to serialize concurrent `omb team merge` invocations on the
 * same team. Uses the same mkdir-atomic + owner-token + stale-recovery pattern
 * as withScalingLock. Lock directory: .omb/team/<sanitized-name>/merge/.lock
 * (relative to the team state root).
 *
 * @param teamName - Team name (must be sanitized by caller; teamDir handles path)
 * @param cwd - Working directory used to resolve the team state root
 * @param lockStaleMs - Milliseconds before a held lock is considered stale and
 *   forcibly recovered. Defaults to 300_000 (5 min) when 0/undefined is passed.
 * @param deps - Path helpers (teamDir, taskClaimLockDir, mailboxLockDir).
 *   Same shape used by other lock helpers in this module.
 * @param fn - Async function to run while holding the lock.
 * @returns Result of `fn`. Lock is released even if `fn` throws.
 */
export async function withMergeLock<T>(
  teamName: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  fn: () => Promise<T>,
): Promise<T> {
  const effectiveStaleMs = lockStaleMs && lockStaleMs > 0 ? lockStaleMs : 300_000;
  const lockDir = join(deps.teamDir(teamName, cwd), 'merge', '.lock');
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + 10_000;
  await mkdir(dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, effectiveStaleMs)) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring merge lock for team ${teamName}`);
      }
      await sleep(LOCK_OWNER_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}
