import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { withPathLock } from '../state/locks.js';
import { initTeamState, appendTeamEvent, teamEventLogPath } from '../state.js';
import { readTeamEvents, readTeamEventsDetailed, rotateTeamEventLog, waitForTeamEvent } from '../state/events.js';

async function setupTeam(name: string): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), `omb-team-events-${name}-`));
  await initTeamState(name, 'event test', 'executor', 2, cwd);
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

describe('team/state/events', () => {
  it('reads canonical filtered events', async () => {
    const { cwd, cleanup } = await setupTeam('canonical-filter');
    try {
      const baseline = await appendTeamEvent('canonical-filter', {
        type: 'task_completed',
        worker: 'worker-2',
        task_id: '2',
      }, cwd);
      await appendTeamEvent('canonical-filter', {
        type: 'worker_idle',
        worker: 'worker-1',
        task_id: '1',
        prev_state: 'working',
      }, cwd);

      const events = await readTeamEvents('canonical-filter', cwd, {
        afterEventId: baseline.event_id,
        type: 'worker_idle',
        worker: 'worker-1',
        taskId: '1',
      });

      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, 'worker_state_changed');
      assert.equal(events[0]?.source_type, 'worker_idle');
      assert.equal(events[0]?.worker, 'worker-1');
      assert.equal(events[0]?.task_id, '1');
    } finally {
      await cleanup();
    }
  });



  it('treats merge conflicts and stale alerts as wakeable while keeping diff reports audit-only', async () => {
    const { cwd, cleanup } = await setupTeam('wakeable-matrix');
    try {
      const baseline = await appendTeamEvent('wakeable-matrix', {
        type: 'worker_diff_report',
        worker: 'worker-1',
        task_id: '1',
        reason: 'diff persisted',
        metadata: {
          worktree_path: '/tmp/team/worktrees/worker-1',
          diff_path: '/tmp/team/worktrees/worker-1/.omb/diff.md',
        },
      }, cwd);
      await appendTeamEvent('wakeable-matrix', {
        type: 'worker_merge_conflict',
        worker: 'worker-1',
        task_id: '1',
        reason: 'merge conflict',
        metadata: {
          worktree_path: '/tmp/team/worktrees/worker-1',
          diff_path: '/tmp/team/worktrees/worker-1/.omb/diff.md',
        },
      }, cwd);
      await appendTeamEvent('wakeable-matrix', {
        type: 'worker_cherry_pick_conflict',
        worker: 'worker-1',
        task_id: '1',
        reason: 'cherry-pick conflict',
        metadata: {
          worktree_path: '/tmp/team/worktrees/worker-1',
          conflict_files: ['src/team/runtime.ts'],
        },
      }, cwd);
      await appendTeamEvent('wakeable-matrix', {
        type: 'worker_rebase_conflict',
        worker: 'worker-1',
        task_id: '1',
        reason: 'rebase conflict',
        metadata: {
          worktree_path: '/tmp/team/worktrees/worker-1',
          conflict_files: ['src/team/runtime.ts'],
        },
      }, cwd);
      await appendTeamEvent('wakeable-matrix', {
        type: 'worker_cross_rebase_applied',
        worker: 'worker-2',
        task_id: '2',
        reason: 'cross rebase applied',
        metadata: {
          worktree_path: '/tmp/team/worktrees/worker-2',
          leader_head: 'abc123',
        },
      }, cwd);
      await appendTeamEvent('wakeable-matrix', {
        type: 'worker_cross_rebase_conflict',
        worker: 'worker-2',
        task_id: '2',
        reason: 'cross rebase conflict',
        metadata: {
          worktree_path: '/tmp/team/worktrees/worker-2',
          conflict_files: ['src/team/runtime.ts'],
        },
      }, cwd);
      await appendTeamEvent('wakeable-matrix', {
        type: 'worker_cross_rebase_skipped',
        worker: 'worker-2',
        task_id: '2',
        reason: 'dirty worktree',
        metadata: {
          worktree_path: '/tmp/team/worktrees/worker-2',
          worker_state: 'working',
        },
      }, cwd);
      await appendTeamEvent('wakeable-matrix', {
        type: 'worker_stale_stdout',
        worker: 'worker-2',
        reason: 'stdout stale',
        metadata: {
          stale_window_ms: 30000,
        },
      }, cwd);

      const wakeable = await readTeamEvents('wakeable-matrix', cwd, {
        afterEventId: baseline.event_id,
        wakeableOnly: true,
      });
      assert.deepEqual(
        wakeable.map((event) => event.type),
        ['worker_merge_conflict', 'worker_cherry_pick_conflict', 'worker_rebase_conflict', 'worker_cross_rebase_conflict', 'worker_stale_stdout'],
      );
      assert.equal(wakeable[0]?.metadata?.diff_path, '/tmp/team/worktrees/worker-1/.omb/diff.md');
      assert.deepEqual(wakeable[1]?.metadata?.conflict_files, ['src/team/runtime.ts']);
      assert.deepEqual(wakeable[2]?.metadata?.conflict_files, ['src/team/runtime.ts']);
      assert.deepEqual(wakeable[3]?.metadata?.conflict_files, ['src/team/runtime.ts']);
      assert.equal(wakeable[4]?.metadata?.stale_window_ms, 30000);

      const all = await readTeamEvents('wakeable-matrix', cwd, {
        afterEventId: baseline.event_id,
        wakeableOnly: false,
      });
      assert.deepEqual(
        all.map((event) => event.type),
        [
          'worker_merge_conflict',
          'worker_cherry_pick_conflict',
          'worker_rebase_conflict',
          'worker_cross_rebase_applied',
          'worker_cross_rebase_conflict',
          'worker_cross_rebase_skipped',
          'worker_stale_stdout',
        ],
      );
    } finally {
      await cleanup();
    }
  });

  it('waits for the next matching filtered event', async () => {
    const { cwd, cleanup } = await setupTeam('await-filter');
    try {
      const waitPromise = waitForTeamEvent('await-filter', cwd, {
        timeoutMs: 500,
        pollMs: 25,
        wakeableOnly: false,
        type: 'task_completed',
        worker: 'worker-1',
        taskId: '1',
      });

      setTimeout(() => {
        void appendTeamEvent('await-filter', {
          type: 'worker_state_changed',
          worker: 'worker-2',
          task_id: '2',
          state: 'working',
        }, cwd);
      }, 25);

      setTimeout(() => {
        void appendTeamEvent('await-filter', {
          type: 'task_completed',
          worker: 'worker-1',
          task_id: '1',
        }, cwd);
      }, 60);

      const result = await waitPromise;
      assert.equal(result.status, 'event');
      assert.equal(result.event?.type, 'task_completed');
      assert.equal(result.event?.worker, 'worker-1');
      assert.equal(result.event?.task_id, '1');
    } finally {
      await cleanup();
    }
  });

  it('reports malformed lines without silently dropping diagnostics', async () => {
    const { cwd, cleanup } = await setupTeam('malformed-diagnostics');
    try {
      const logPath = teamEventLogPath('malformed-diagnostics', cwd);
      await appendTeamEvent('malformed-diagnostics', {
        type: 'task_completed',
        worker: 'worker-1',
        task_id: '1',
      }, cwd);
      await appendFile(logPath, '{"broken":true\n', 'utf8');

      const result = await readTeamEventsDetailed('malformed-diagnostics', cwd, { wakeableOnly: false });
      assert.equal(result.events.length, 1);
      assert.equal(result.diagnostics.malformed_line_count, 1);
      assert.equal(result.diagnostics.cursor_missing, false);
    } finally {
      await cleanup();
    }
  });

  it('returns cursor_missing when the baseline event was rotated away', async () => {
    const { cwd, cleanup } = await setupTeam('cursor-missing');
    try {
      const baseline = await appendTeamEvent('cursor-missing', {
        type: 'team_leader_nudge',
        worker: 'leader-fixed',
        reason: 'baseline',
      }, cwd);
      for (let index = 0; index < 12; index += 1) {
        await appendTeamEvent('cursor-missing', {
          type: 'worker_state_changed',
          worker: 'worker-1',
          state: index % 2 === 0 ? 'working' : 'blocked',
          prev_state: index % 2 === 0 ? 'idle' : 'working',
          reason: `event-${index}-${'x'.repeat(256)}`,
        }, cwd);
      }

      const rotated = await rotateTeamEventLog('cursor-missing', cwd, 1024);
      assert.equal(rotated, true);

      const readResult = await readTeamEventsDetailed('cursor-missing', cwd, {
        afterEventId: baseline.event_id,
        wakeableOnly: false,
      });
      assert.equal(readResult.diagnostics.cursor_missing, true);
      assert.equal(readResult.diagnostics.cursor_found, false);
      assert.notEqual(readResult.diagnostics.latest_available_cursor, '');

      const waitResult = await waitForTeamEvent('cursor-missing', cwd, {
        afterEventId: baseline.event_id,
        timeoutMs: 100,
        pollMs: 25,
        wakeableOnly: false,
      });
      assert.equal(waitResult.status, 'cursor_missing');
      assert.equal(waitResult.cursor, baseline.event_id);
      assert.equal(waitResult.diagnostics.cursor_missing, true);
    } finally {
      await cleanup();
    }
  });

  it('serializes rotation and append on the same event-log lock', async () => {
    const { cwd, cleanup } = await setupTeam('rotate-lock');
    try {
      for (let index = 0; index < 24; index += 1) {
        await appendTeamEvent('rotate-lock', {
          type: 'task_completed',
          worker: 'worker-1',
          task_id: `${index}`,
          reason: `seed-${index}-${'x'.repeat(256)}`,
        }, cwd);
      }

      const logPath = teamEventLogPath('rotate-lock', cwd);
      const lockDir = join(dirname(logPath), '.lock.events');
      let rotateSettled = false;
      let appendSettled = false;

      const pending = await withPathLock(lockDir, { label: 'test event log lock' }, async () => {
        const rotatePromise = rotateTeamEventLog('rotate-lock', cwd, 1024).finally(() => {
          rotateSettled = true;
        });
        const lateEventPromise = appendTeamEvent('rotate-lock', {
          type: 'task_completed',
          worker: 'worker-2',
          task_id: 'late',
          reason: 'late-event',
        }, cwd).finally(() => {
          appendSettled = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(rotateSettled, false);
        assert.equal(appendSettled, false);
        return { rotatePromise, lateEventPromise };
      });

      const lateEvent = await pending.lateEventPromise;
      await pending.rotatePromise;

      const events = await readTeamEvents('rotate-lock', cwd, { wakeableOnly: false });
      assert.equal(events.some((event) => event.event_id === lateEvent.event_id), true);
    } finally {
      await cleanup();
    }
  });

  it('preserves metadata for diff and merge events while filtering wakeable events correctly', async () => {
    const { cwd, cleanup } = await setupTeam('metadata-wakeable');
    try {
      await appendTeamEvent('metadata-wakeable', {
        type: 'worker_diff_report',
        worker: 'worker-1',
        metadata: {
          summary: 'worker diff report',
          worktree_path: '/tmp/team/worktrees/worker-1',
          diff_path: '/tmp/team/worktrees/worker-1/.omb/diff.md',
          full_diff_available: true,
        },
      }, cwd);
      await appendTeamEvent('metadata-wakeable', {
        type: 'worker_merge_conflict',
        worker: 'worker-1',
        metadata: {
          summary: 'merge conflict',
          worktree_path: '/tmp/team/worktrees/worker-1',
          conflict_files: ['src/team/runtime.ts'],
        },
      }, cwd);
      await appendTeamEvent('metadata-wakeable', {
        type: 'worker_stale_stdout',
        worker: 'worker-1',
        metadata: {
          summary: 'stdout stale',
          stale_window_ms: 60_000,
        },
      }, cwd);

      const allEvents = await readTeamEvents('metadata-wakeable', cwd, { wakeableOnly: false });
      const diffReport = allEvents.find((event) => event.type === 'worker_diff_report');
      const mergeConflict = allEvents.find((event) => event.type === 'worker_merge_conflict');
      const staleStdout = allEvents.find((event) => event.type === 'worker_stale_stdout');

      assert.equal(diffReport?.metadata?.summary, 'worker diff report');
      assert.equal(diffReport?.metadata?.diff_path, '/tmp/team/worktrees/worker-1/.omb/diff.md');
      assert.equal(mergeConflict?.metadata?.summary, 'merge conflict');
      assert.deepEqual(mergeConflict?.metadata?.conflict_files, ['src/team/runtime.ts']);
      assert.equal(staleStdout?.metadata?.stale_window_ms, 60_000);

      const wakeableEvents = await readTeamEvents('metadata-wakeable', cwd, { wakeableOnly: true });
      assert.equal(wakeableEvents.some((event) => event.type === 'worker_diff_report'), false);
      assert.equal(wakeableEvents.some((event) => event.type === 'worker_merge_conflict'), true);
      assert.equal(wakeableEvents.some((event) => event.type === 'worker_stale_stdout'), true);
    } finally {
      await cleanup();
    }
  });
});
