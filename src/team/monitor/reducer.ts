import type { TeamPhase, TerminalPhase } from '../orchestrator.js';
import type { TeamTask, WorkerInfo } from '../team-ops.js';
import type { TeamMonitorSnapshot } from './snapshot.js';

export interface MonitorDecision {
  reclaimedClaims: string[];
  deadWorkers: string[];
  nonReportingWorkers: string[];
  taskAssignments: Array<{ taskId: string; workerId: string; reason: string }>;
  phaseTarget: TeamPhase | TerminalPhase;
  recommendations: string[];
  verificationPendingTaskIds: string[];
  allTasksTerminal: boolean;
  deadWorkerStall: boolean;
}

/**
 * Pure decision function: given a snapshot of team state, produce a decision
 * about what actions to take. No IO, no filesystem, no side effects.
 *
 * This extracts all the decision logic from the old monolithic monitorTeam,
 * making it testable in isolation.
 */
export function decideFromSnapshot(snapshot: TeamMonitorSnapshot): MonitorDecision {
  const {
    tasks,
    workers,
    taskCounts,
    reclaimedTaskIds,
    config,
  } = snapshot;

  const deadWorkers: string[] = [];
  const nonReportingWorkers: string[] = [];
  const recommendations: string[] = [];
  const inProgressByOwner = new Map<string, TeamTask[]>();

  for (const task of tasks) {
    if (task.status !== 'in_progress' || !task.owner) continue;
    const existing = inProgressByOwner.get(task.owner) || [];
    existing.push(task);
    inProgressByOwner.set(task.owner, existing);
  }

  for (const worker of workers) {
    if (!worker.alive) {
      deadWorkers.push(worker.info.name);
      const deadWorkerTasks = inProgressByOwner.get(worker.info.name) || [];
      for (const t of deadWorkerTasks) {
        recommendations.push(`Reassign task-${t.id} from dead ${worker.info.name}`);
      }
    }

    if (worker.alive && worker.turnsWithoutProgress > 5) {
      nonReportingWorkers.push(worker.info.name);
      recommendations.push(`Send reminder to non-reporting ${worker.info.name}`);
    }
  }

  for (const taskId of reclaimedTaskIds) {
    recommendations.push(`Reclaimed expired claim for task-${taskId}`);
  }

  // Verification pending tasks
  const verificationPendingTaskIds: string[] = [];
  for (const task of tasks) {
    if (
      task.status === 'completed'
      && task.requires_code_change === true
      && !hasStructuredVerificationEvidence(task.result)
    ) {
      verificationPendingTaskIds.push(task.id);
      recommendations.push(`Verification evidence missing for task-${task.id}; require structured PASS/FAIL evidence before terminal success`);
    }
  }

  const allTasksTerminal = taskCounts.pending === 0 && taskCounts.blocked === 0 && taskCounts.in_progress === 0;

  const deadWorkerStall =
    config.worker_launch_mode === 'prompt'
    && config.workers.length > 0
    && deadWorkers.length >= config.workers.length
    && !allTasksTerminal;

  // Determine phase target
  const phaseTarget: TeamPhase | TerminalPhase = deadWorkerStall
    ? 'failed'
    : inferPhaseTarget(taskCounts, verificationPendingTaskIds.length > 0);

  if (deadWorkerStall) {
    recommendations.push('All workers are dead while work remains; mark the team failed or restart with fresh workers.');
  }

  // Build rebalance decisions (task assignments)
  const taskAssignments = buildRebalanceAssignments(
    tasks,
    workers,
    reclaimedTaskIds,
    config.workers,
  );

  for (const assignment of taskAssignments) {
    recommendations.push(assignment.reason);
  }

  return {
    reclaimedClaims: reclaimedTaskIds,
    deadWorkers,
    nonReportingWorkers,
    taskAssignments,
    phaseTarget,
    recommendations,
    verificationPendingTaskIds,
    allTasksTerminal,
    deadWorkerStall,
  };
}

function hasStructuredVerificationEvidence(result: string | undefined): boolean {
  if (!result || typeof result !== 'string') return false;
  const upper = result.toUpperCase();
  return upper.includes('PASS') || upper.includes('FAIL');
}

function inferPhaseTarget(
  taskCounts: { pending: number; blocked: number; in_progress: number; completed: number; failed: number },
  verificationPending: boolean,
): TeamPhase | TerminalPhase {
  const { pending, blocked, in_progress, completed, failed } = taskCounts;
  const total = pending + blocked + in_progress + completed + failed;

  if (total === 0) return 'team-exec';
  if (pending > 0 || blocked > 0 || in_progress > 0) return 'team-exec';
  if (verificationPending) return 'team-verify';
  if (failed > 0 && completed === 0) return 'failed';
  if (failed > 0) return 'team-fix';
  return 'complete';
}

interface RebalanceAssignment {
  taskId: string;
  workerId: string;
  reason: string;
}

function buildRebalanceAssignments(
  tasks: TeamTask[],
  workers: TeamMonitorSnapshot['workers'],
  reclaimedTaskIds: string[],
  configWorkers: WorkerInfo[],
): RebalanceAssignment[] {
  const assignments: RebalanceAssignment[] = [];
  const reclaimedSet = new Set(reclaimedTaskIds);

  const idleWorkers = workers.filter(
    (w) => w.alive && (w.status.state === 'idle' || w.status.state === 'unknown'),
  );

  const pendingOrReclaimedTasks = tasks.filter(
    (t) => t.status === 'pending' || (t.status === 'in_progress' && reclaimedSet.has(t.id)),
  );

  if (idleWorkers.length === 0 || pendingOrReclaimedTasks.length === 0) return assignments;

  for (const task of pendingOrReclaimedTasks) {
    if (assignments.some((a) => a.taskId === task.id)) continue;

    // Simple round-robin: pick the idle worker with fewest assigned tasks
    const worker = idleWorkers.sort((a, b) => {
      const aTasks = configWorkers.find((cw) => cw.name === a.info.name)?.assigned_tasks.length ?? 0;
      const bTasks = configWorkers.find((cw) => cw.name === b.info.name)?.assigned_tasks.length ?? 0;
      return aTasks - bTasks;
    })[0];

    if (worker) {
      assignments.push({
        taskId: task.id,
        workerId: worker.info.name,
        reason: `Assigned task-${task.id} to ${worker.info.name}: rebalance (reclaimed=${reclaimedSet.has(task.id)})`,
      });
    }
  }

  return assignments;
}
