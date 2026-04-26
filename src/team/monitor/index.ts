import { performance } from 'perf_hooks';
import {
  sanitizeTeamName,
  isWorkerAlive,
} from '../tmux-session.js';
import {
  teamReadConfig as readTeamConfig,
  teamReadManifest as readTeamManifestV2,
  teamReadWorkerHeartbeat as readWorkerHeartbeat,
  teamReadWorkerStatus as readWorkerStatus,
  teamListTasks as listTasks,
  teamReclaimExpiredTaskClaim as reclaimExpiredTaskClaim,
  teamClaimTask as claimTask,
  teamAppendEvent as appendTeamEvent,
  teamReadMonitorSnapshot as readMonitorSnapshot,
  teamWriteMonitorSnapshot as writeMonitorSnapshot,
  teamReadPhase as readTeamPhaseState,
  teamWritePhase as writeTeamPhaseState,
  type TeamConfig,
  type TeamMonitorSnapshotState,
  type TeamPhaseState,
} from '../team-ops.js';
import { inferPhaseTargetFromTaskCounts, reconcilePhaseStateForMonitor } from '../phase-controller.js';
import { hasStructuredVerificationEvidence } from '../../verification/verifier.js';
import type { TeamPhase, TerminalPhase } from '../orchestrator.js';
import type { TeamMonitorSnapshot } from './snapshot.js';
import { decideFromSnapshot, type MonitorDecision } from './reducer.js';

export interface MonitorCycleResult {
  snapshot: TeamMonitorSnapshot | null;
  decision: MonitorDecision | null;
  phase: TeamPhase | TerminalPhase | null;
}

/**
 * One monitor cycle: scan → decide → actuate → persist.
 *
 * This is the decomposed version of the old monolithic monitorTeam.
 * The scan step builds a snapshot, the decide step runs the pure reducer,
 * and the actuate+persist steps execute side effects.
 */
export async function monitorTeamCycle(cwd: string, teamName: string): Promise<MonitorCycleResult> {
  const monitorStartMs = performance.now();
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return { snapshot: null, decision: null, phase: null };

  // ── 1. Scan: build snapshot ──
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const previousSnapshot = await readMonitorSnapshot(sanitized, cwd);

  const sessionName = config.tmux_session;
  const listTasksStartMs = performance.now();
  const allTasks = await listTasks(sanitized, cwd);
  const listTasksMs = performance.now() - listTasksStartMs;

  const reclaimedTaskIds: string[] = [];
  for (const task of allTasks) {
    if (task.status !== 'in_progress' || !task.claim?.leased_until) continue;
    if (new Date(task.claim.leased_until) > new Date()) continue;
    const reclaimed = await reclaimExpiredTaskClaim(sanitized, task.id, cwd);
    if (reclaimed.ok && reclaimed.reclaimed) reclaimedTaskIds.push(task.id);
  }

  let taskView = reclaimedTaskIds.length > 0 ? await listTasks(sanitized, cwd) : allTasks;
  const taskById = new Map(taskView.map((task) => [task.id, task] as const));

  const workerScanStartMs = performance.now();
  const workerSignals = await Promise.all(
    config.workers.map(async (worker) => {
      const alive = config.worker_launch_mode === 'prompt'
        ? false // Prompt worker alive check needs runtime handle — handled at actuate layer
        : isWorkerAlive(sessionName, worker.index, worker.pane_id);
      const [status, heartbeat] = await Promise.all([
        readWorkerStatus(sanitized, worker.name, cwd),
        readWorkerHeartbeat(sanitized, worker.name, cwd),
      ]);
      return { worker, alive, status, heartbeat };
    }),
  );
  const workerScanMs = performance.now() - workerScanStartMs;

  const workers: TeamMonitorSnapshot['workers'] = [];
  for (const { worker: w, alive, status, heartbeat } of workerSignals) {
    const currentTask = status.current_task_id ? taskById.get(status.current_task_id) ?? null : null;
    const previousTurns = previousSnapshot ? (previousSnapshot.workerTurnCountByName[w.name] ?? 0) : null;
    const previousTaskId = previousSnapshot?.workerTaskIdByName[w.name] ?? '';
    const currentTaskId = status.current_task_id ?? '';
    const turnsWithoutProgress =
      heartbeat &&
      previousTurns !== null &&
      status.state === 'working' &&
      currentTask &&
      (currentTask.status === 'pending' || currentTask.status === 'in_progress') &&
      currentTaskId !== '' &&
      previousTaskId === currentTaskId
        ? Math.max(0, heartbeat.turn_count - previousTurns)
        : 0;

    workers.push({
      info: w,
      alive,
      status,
      heartbeat,
      assignedTasks: w.assigned_tasks,
      turnsWithoutProgress,
    });
  }

  const taskCounts = {
    total: taskView.length,
    pending: taskView.filter(t => t.status === 'pending').length,
    blocked: taskView.filter(t => t.status === 'blocked').length,
    in_progress: taskView.filter(t => t.status === 'in_progress').length,
    completed: taskView.filter(t => t.status === 'completed').length,
    failed: taskView.filter(t => t.status === 'failed').length,
  };

  const allTasksTerminal = taskCounts.pending === 0 && taskCounts.blocked === 0 && taskCounts.in_progress === 0;
  const deadWorkerStall =
    config.worker_launch_mode === 'prompt'
    && config.workers.length > 0
    && workers.filter(w => !w.alive).length >= config.workers.length
    && !allTasksTerminal;

  const persistedPhase = await readTeamPhaseState(sanitized, cwd);
  const verificationPendingTasks = taskView.filter(
    (task) => task.status === 'completed'
      && task.requires_code_change === true
      && !hasStructuredVerificationEvidence(task.result),
  );
  const targetPhase = deadWorkerStall
    ? 'failed'
    : inferPhaseTargetFromTaskCounts(taskCounts, {
      verificationPending: verificationPendingTasks.length > 0,
    });
  const phaseState: TeamPhaseState = reconcilePhaseStateForMonitor(persistedPhase, targetPhase);
  const phase: TeamPhase | TerminalPhase = phaseState.current_phase;

  const snapshot: TeamMonitorSnapshot = {
    timestamp: new Date().toISOString(),
    manifest,
    tasks: taskView,
    workers,
    phase,
    taskCounts,
    reclaimedTaskIds,
    deadWorkers: workers.filter(w => !w.alive).map(w => w.info.name),
    nonReportingWorkers: workers.filter(w => w.alive && w.turnsWithoutProgress > 5).map(w => w.info.name),
    allTasksTerminal,
    deadWorkerStall,
    previousSnapshot,
    config,
    performance: {
      listTasksMs,
      workerScanMs,
      totalMs: performance.now() - monitorStartMs,
    },
  };

  // ── 2. Decide: run pure reducer ──
  const decision = decideFromSnapshot(snapshot);

  // ── 3. Actuate: execute decisions ──
  let assignedDuringMonitor = false;
  for (const assignment of decision.taskAssignments) {
    try {
      await claimTask(sanitized, assignment.taskId, assignment.workerId, 1, cwd);
      assignedDuringMonitor = true;
    } catch {
      // Assignment failure handled in recommendations
    }
  }

  if (assignedDuringMonitor) {
    taskView = await listTasks(sanitized, cwd);
  }

  await writeTeamPhaseState(sanitized, phaseState, cwd);

  // Emit derived events
  await emitMonitorDerivedEvents(sanitized, taskView, workers, previousSnapshot, config.worker_launch_mode, cwd);

  // ── 4. Persist: save snapshot ──
  const updatedAt = new Date().toISOString();
  const totalMs = performance.now() - monitorStartMs;
  const mailboxNotifiedByMessageId = previousSnapshot?.mailboxNotifiedByMessageId ?? {};

  await writeMonitorSnapshot(
    sanitized,
    {
      taskStatusById: Object.fromEntries(taskView.map((t) => [t.id, t.status])),
      workerAliveByName: Object.fromEntries(workers.map((w) => [w.info.name, w.alive])),
      workerStateByName: Object.fromEntries(workers.map((w) => [w.info.name, w.status.state])),
      workerTurnCountByName: Object.fromEntries(workers.map((w) => [w.info.name, w.heartbeat?.turn_count ?? 0])),
      workerTaskIdByName: Object.fromEntries(workers.map((w) => [w.info.name, w.status.current_task_id ?? ''])),
      mailboxNotifiedByMessageId,
      completedEventTaskIds: previousSnapshot?.completedEventTaskIds ?? {},
      monitorTimings: {
        list_tasks_ms: Number(listTasksMs.toFixed(2)),
        worker_scan_ms: Number(workerScanMs.toFixed(2)),
        mailbox_delivery_ms: 0,
        total_ms: Number(totalMs.toFixed(2)),
        updated_at: updatedAt,
      },
    },
    cwd,
  );

  return { snapshot, decision, phase };
}

async function emitMonitorDerivedEvents(
  teamName: string,
  tasks: TeamMonitorSnapshot['tasks'],
  workers: TeamMonitorSnapshot['workers'],
  previous: TeamMonitorSnapshotState | null,
  workerLaunchMode: TeamConfig['worker_launch_mode'],
  cwd: string,
): Promise<void> {
  for (const task of tasks) {
    const prevStatus = previous?.taskStatusById[task.id];
    if (prevStatus && prevStatus !== 'completed' && task.status === 'completed') {
      if (previous?.completedEventTaskIds?.[task.id]) continue;
      await appendTeamEvent(
        teamName,
        {
          type: 'task_completed',
          worker: task.owner || 'unknown',
          task_id: task.id,
          message_id: null,
          reason: undefined,
        },
        cwd,
      );
    }
  }

  for (const worker of workers) {
    const prevAlive = previous?.workerAliveByName[worker.info.name];
    const shouldEmitInitialPromptWorkerStop = workerLaunchMode === 'prompt' && prevAlive === undefined;
    if ((prevAlive === true || shouldEmitInitialPromptWorkerStop) && worker.alive === false) {
      await appendTeamEvent(
        teamName,
        {
          type: 'worker_stopped',
          worker: worker.info.name,
          task_id: worker.status.current_task_id,
          message_id: null,
          reason: worker.status.reason,
        },
        cwd,
      );
    }

    const prevState = previous?.workerStateByName[worker.info.name];
    if (prevState && prevState !== worker.status.state) {
      await appendTeamEvent(
        teamName,
        {
          type: 'worker_state_changed',
          worker: worker.info.name,
          task_id: worker.status.current_task_id,
          message_id: null,
          reason: worker.status.reason,
          state: worker.status.state,
          prev_state: prevState,
        },
        cwd,
      );
    }

    if (prevState && prevState !== 'idle' && worker.status.state === 'idle') {
      await appendTeamEvent(
        teamName,
        {
          type: 'worker_idle',
          worker: worker.info.name,
          task_id: worker.status.current_task_id,
          message_id: null,
          reason: undefined,
          prev_state: prevState,
          state: 'idle',
          source_type: 'worker_idle',
        },
        cwd,
      );
    }
  }
}
