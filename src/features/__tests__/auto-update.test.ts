import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAutoUpdateFlow } from '../auto-update.js';

describe('runAutoUpdateFlow', () => {
  async function withInteractiveTty(run: () => Promise<void>): Promise<void> {
    const originalStdinTty = process.stdin.isTTY;
    const originalStdoutTty = process.stdout.isTTY;

    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });

    try {
      await run();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: originalStdinTty,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: originalStdoutTty,
      });
    }
  }

  it('supports dry-run mode without executing the update or setup refresh', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omb-auto-update-'));
    const originalLog = console.log;
    const logs: string[] = [];
    let updateAttempts = 0;
    let setupRefreshes = 0;

    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      await withInteractiveTty(async () => {
        await runAutoUpdateFlow(cwd, {
          dryRun: true,
          dependencies: {
            askYesNo: async () => true,
            fetchLatestVersion: async () => '0.9.0',
            getCurrentVersion: async () => '0.8.9',
            runGlobalUpdate: () => {
              updateAttempts += 1;
              return { ok: true, stderr: '' };
            },
            refreshSetup: async () => {
              setupRefreshes += 1;
            },
          },
        });
      });

      assert.equal(updateAttempts, 0);
      assert.equal(setupRefreshes, 0);
      assert.match(
        logs.join('\n'),
        /Dry run: would run npm install -g oh-my-codebuddy@latest and refresh setup/,
      );

      const state = JSON.parse(
        await readFile(join(cwd, '.omb', 'state', 'update-check.json'), 'utf-8'),
      ) as { last_seen_latest?: string };
      assert.equal(state.last_seen_latest, '0.9.0');
    } finally {
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
