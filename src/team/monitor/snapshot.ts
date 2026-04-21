import type { TeamPhase, TerminalPhase } from '../orchestrator.js';
import type { TeamTask, TeamManifestV2, TeamConfig, WorkerInfo, WorkerStatus, WorkerHeartbeat, TeamMonitorSnapshotState } from '../team-ops.js';

export interface TeamMonitorSnapshot {
  timestamp: string;
  manifest: TeamManifestV2 | null;
  tasks: TeamTask[];
  workers: Array<{
    info: WorkerInfo;
    alive: boolean;
    status: WorkerStatus;
    heartbeat: WorkerHeartbeat | null;
    assignedTasks: string[];
    turnsWithoutProgress: number;
  }>;
  phase: TeamPhase | TerminalPhase;
  taskCounts: {
    total: number;
    pending: number;
    blocked: number;
    in_progress: number;
    completed: number;
    failed: number;
  };
  reclaimedTaskIds: string[];
  deadWorkers: string[];
  nonReportingWorkers: string[];
  allTasksTerminal: boolean;
  deadWorkerStall: boolean;
  previousSnapshot: TeamMonitorSnapshotState | null;
  config: TeamConfig;
  performance: {
    listTasksMs: number;
    workerScanMs: number;
    totalMs: number;
  };
}
