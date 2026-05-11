import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withMergeLock } from '../state/locks.js';

const deps = {
  teamDir: (name: string, cwd: string) => join(cwd, '.omb', 'state', 'team', name),
  taskClaimLockDir: (name: string, taskId: string, cwd: string) =>
    join(cwd, '.omb', 'state', 'team', name, 'claims', `task-${taskId}.lock`),
  mailboxLockDir: (name: string, worker: string, cwd: string) =>
    join(cwd, '.omb', 'state', 'team', name, 'mailbox', `.lock-${worker}`),
};

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omb-merge-lock-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('withMergeLock', () => {
  it('(a) two concurrent withMergeLock calls on same team are serialized', async () => {
    const counterPath = join(cwd, 'counter.txt');
    await writeFile(counterPath, '0', 'utf8');

    const teamName = 'serial-test';

    async function incrementCounter(): Promise<void> {
      return withMergeLock(teamName, cwd, 0, deps, async () => {
        const val = parseInt(await readFile(counterPath, 'utf8'), 10);
        // Simulate some work duration so the race condition would manifest
        // if the lock were not held.
        await new Promise((resolve) => setTimeout(resolve, 50));
        await writeFile(counterPath, String(val + 1), 'utf8');
      });
    }

    await Promise.all([incrementCounter(), incrementCounter()]);

    const final = parseInt(await readFile(counterPath, 'utf8'), 10);
    assert.equal(final, 2);
  });

  it('(b) stale lock is recovered', async () => {
    const teamName = 'stale-test';
    const lockDir = join(deps.teamDir(teamName, cwd), 'merge', '.lock');

    // Pre-create the lock directory
    mkdirSync(lockDir, { recursive: true });

    // Write an owner file
    const ownerPath = join(lockDir, 'owner');
    await writeFile(ownerPath, 'old-owner-token', 'utf8');

    // Set mtime to 10 minutes ago so the lock appears stale
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockDir, tenMinutesAgo, tenMinutesAgo);

    // withMergeLock with lockStaleMs=1000 should recover the stale lock
    const result = await withMergeLock(teamName, cwd, 1_000, deps, async () => 'recovered');

    assert.equal(result, 'recovered');
  });

  it('(c) lock is released after fn throws, and can be re-acquired', async () => {
    const teamName = 'throw-test';
    const lockDir = join(deps.teamDir(teamName, cwd), 'merge', '.lock');

    // Call withMergeLock with a fn that throws
    await assert.rejects(
      withMergeLock(teamName, cwd, 0, deps, async () => {
        throw new Error('intentional test error');
      }),
      { message: 'intentional test error' },
    );

    // Lock directory should not exist after the throw
    assert.equal(existsSync(lockDir), false);

    // Should be able to acquire the lock again
    const result = await withMergeLock(teamName, cwd, 0, deps, async () => 'success-after-throw');
    assert.equal(result, 'success-after-throw');
  });
});
