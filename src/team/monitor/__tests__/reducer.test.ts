import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { decideFromSnapshot, type MonitorDecision } from '../reducer.js';
import type { TeamMonitorSnapshot } from '../snapshot.js';
import type { TeamPhase, TerminalPhase } from '../../orchestrator.js';
import type { TeamTask, TeamConfig, WorkerInfo, WorkerStatus, WorkerHeartbeat, TeamMonitorSnapshotState } from '../../team-ops.js';

function makeWorkerInfo(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    name: 'worker-1',
    index: 1,
    role: 'executor',
    assigned_tasks: [],
    ...overrides,
  };
}

function makeWorkerStatus(overrides: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    state: 'idle',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return {
    name: 'test-team',
    task: 'test task',
    agent_type: 'executor',
    worker_launch_mode: 'interactive',
    lifecycle_profile: 'default',
    worker_count: 1,
    max_workers: 20,
    workers: [makeWorkerInfo()],
    created_at: new Date().toISOString(),
    tmux_session: 'omb-team-test-team',
    next_task_id: 1,
    leader_pane_id: null,
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<TeamMonitorSnapshot> = {}): TeamMonitorSnapshot {
  const config = makeConfig();
  return {
    timestamp: new Date().toISOString(),
    manifest: null,
    tasks: [],
    workers: [],
    phase: 'team-exec',
    taskCounts: { total: 0, pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0 },
    reclaimedTaskIds: [],
    deadWorkers: [],
    nonReportingWorkers: [],
    allTasksTerminal: true,
    deadWorkerStall: false,
    previousSnapshot: null,
    config,
    performance: { listTasksMs: 0, workerScanMs: 0, totalMs: 0 },
    ...overrides,
  };
}

describe('decideFromSnapshot', () => {
  it('identifies dead workers', () => {
    const snapshot = makeSnapshot({
      workers: [
        { info: makeWorkerInfo({ name: 'worker-1' }), alive: false, status: makeWorkerStatus(), heartbeat: null, assignedTasks: [], turnsWithoutProgress: 0 },
        { info: makeWorkerInfo({ name: 'worker-2', index: 2 }), alive: true, status: makeWorkerStatus(), heartbeat: null, assignedTasks: [], turnsWithoutProgress: 0 },
      ],
    });

    const decision = decideFromSnapshot(snapshot);
    assert.deepStrictEqual(decision.deadWorkers, ['worker-1']);
    assert.ok(!decision.deadWorkers.includes('worker-2'));
  });

  it('identifies non-reporting workers with high turnsWithoutProgress', () => {
    const snapshot = makeSnapshot({
      workers: [
        { info: makeWorkerInfo({ name: 'worker-1' }), alive: true, status: makeWorkerStatus({ state: 'working' }), heartbeat: null, assignedTasks: [], turnsWithoutProgress: 7 },
      ],
    });

    const decision = decideFromSnapshot(snapshot);
    assert.ok(decision.nonReportingWorkers.includes('worker-1'));
  });

  it('does not flag idle workers as non-reporting', () => {
    const snapshot = makeSnapshot({
      workers: [
        { info: makeWorkerInfo({ name: 'worker-1' }), alive: true, status: makeWorkerStatus({ state: 'idle' }), heartbeat: null, assignedTasks: [], turnsWithoutProgress: 0 },
      ],
    });

    const decision = decideFromSnapshot(snapshot);
    assert.deepStrictEqual(decision.nonReportingWorkers, []);
  });

  it('recommends reassigning tasks from dead workers', () => {
    const snapshot = makeSnapshot({
      tasks: [
        { id: 't1', subject: 'task 1', description: '', status: 'in_progress', owner: 'worker-1', created_at: new Date().toISOString() } as TeamTask,
      ],
      workers: [
        { info: makeWorkerInfo({ name: 'worker-1' }), alive: false, status: makeWorkerStatus(), heartbeat: null, assignedTasks: ['t1'], turnsWithoutProgress: 0 },
      ],
    });

    const decision = decideFromSnapshot(snapshot);
    assert.ok(decision.recommendations.some((r) => r.includes('Reassign task-t1 from dead worker-1')));
  });

  it('detects dead worker stall in prompt mode', () => {
    const config = makeConfig({ worker_launch_mode: 'prompt' });
    const snapshot = makeSnapshot({
      config,
      workers: [
        { info: makeWorkerInfo({ name: 'worker-1' }), alive: false, status: makeWorkerStatus(), heartbeat: null, assignedTasks: [], turnsWithoutProgress: 0 },
      ],
      taskCounts: { total: 1, pending: 1, blocked: 0, in_progress: 0, completed: 0, failed: 0 },
      allTasksTerminal: false,
    });

    const decision = decideFromSnapshot(snapshot);
    assert.equal(decision.deadWorkerStall, true);
    assert.equal(decision.phaseTarget, 'failed');
  });

  it('detects all tasks terminal', () => {
    const snapshot = makeSnapshot({
      taskCounts: { total: 2, pending: 0, blocked: 0, in_progress: 0, completed: 2, failed: 0 },
      allTasksTerminal: true,
    });

    const decision = decideFromSnapshot(snapshot);
    assert.equal(decision.allTasksTerminal, true);
    assert.equal(decision.phaseTarget, 'complete');
  });

  it('flags verification pending tasks', () => {
    const snapshot = makeSnapshot({
      tasks: [
        { id: 't1', subject: 'task 1', description: '', status: 'completed', requires_code_change: true, result: 'some text without structured evidence', owner: 'worker-1', created_at: new Date().toISOString() } as TeamTask,
      ],
      taskCounts: { total: 1, pending: 0, blocked: 0, in_progress: 0, completed: 1, failed: 0 },
    });

    const decision = decideFromSnapshot(snapshot);
    assert.ok(decision.verificationPendingTaskIds.includes('t1'));
  });

  it('does not flag tasks with structured verification evidence', () => {
    const snapshot = makeSnapshot({
      tasks: [
        { id: 't1', subject: 'task 1', description: '', status: 'completed', requires_code_change: true, result: 'PASS: all tests pass', owner: 'worker-1', created_at: new Date().toISOString() } as TeamTask,
      ],
      taskCounts: { total: 1, pending: 0, blocked: 0, in_progress: 0, completed: 1, failed: 0 },
    });

    const decision = decideFromSnapshot(snapshot);
    assert.deepStrictEqual(decision.verificationPendingTaskIds, []);
  });

  it('includes reclaimed claim recommendations', () => {
    const snapshot = makeSnapshot({
      reclaimedTaskIds: ['t1', 't2'],
    });

    const decision = decideFromSnapshot(snapshot);
    assert.ok(decision.recommendations.some((r) => r.includes('Reclaimed expired claim for task-t1')));
    assert.ok(decision.recommendations.some((r) => r.includes('Reclaimed expired claim for task-t2')));
  });

  it('returns in-progress phase when tasks remain', () => {
    const snapshot = makeSnapshot({
      taskCounts: { total: 2, pending: 1, blocked: 0, in_progress: 1, completed: 0, failed: 0 },
      allTasksTerminal: false,
    });

    const decision = decideFromSnapshot(snapshot);
    assert.equal(decision.phaseTarget, 'team-exec');
  });

  it('returns team-fix when there are failures with completions', () => {
    const snapshot = makeSnapshot({
      taskCounts: { total: 2, pending: 0, blocked: 0, in_progress: 0, completed: 1, failed: 1 },
      allTasksTerminal: true,
    });

    const decision = decideFromSnapshot(snapshot);
    assert.equal(decision.phaseTarget, 'team-fix');
  });

  it('returns failed when all tasks failed with no completions', () => {
    const snapshot = makeSnapshot({
      taskCounts: { total: 1, pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 1 },
      allTasksTerminal: true,
    });

    const decision = decideFromSnapshot(snapshot);
    assert.equal(decision.phaseTarget, 'failed');
  });

  it('is a pure function with no side effects', () => {
    const snapshot = makeSnapshot();
    const decision1 = decideFromSnapshot(snapshot);
    const decision2 = decideFromSnapshot(snapshot);
    assert.deepStrictEqual(decision1, decision2);
  });
});
