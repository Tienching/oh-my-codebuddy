/**
 * Worker Health - Composite health assessment for team workers
 *
 * Combines heartbeat freshness, tmux session liveness, and audit log
 * data to produce a comprehensive health report per worker. Detects
 * dead workers, hung workers (tmux alive but heartbeat stale),
 * quarantined workers, and at-risk workers with consecutive errors.
 *
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { countTaskEvents, type AuditEventType } from "./audit-log.js";

// ── Types ──────────────────────────────────────────────────────────────

export type WorkerHealthStatus =
  | "ready"
  | "polling"
  | "executing"
  | "shutdown"
  | "quarantined"
  | "dead"
  | "unknown";

export interface WorkerHealthReport {
  workerName: string;
  isAlive: boolean;
  tmuxSessionAlive: boolean;
  heartbeatAgeMs: number | null;
  status: WorkerHealthStatus;
  consecutiveErrors: number;
  currentTaskId: string | null;
  totalTasksCompleted: number;
  totalTasksFailed: number;
  uptimeMs: number;
}

export interface HealthCheckResult {
  needsIntervention: boolean;
  reason: string | null;
}

// ── Heartbeat reading ──────────────────────────────────────────────────

interface WorkerHeartbeatData {
  workerName?: string;
  status?: string;
  lastPollAt?: string;
  consecutiveErrors?: number;
  currentTaskId?: string;
  pid?: number;
}

function readHeartbeatFile(
  cwd: string,
  teamName: string,
  workerName: string,
): WorkerHeartbeatData | null {
  // Try the bridge-sidecar path first
  const bridgePath = join(
    cwd,
    ".omb",
    "state",
    "team-bridge",
    teamName,
    `${workerName}.heartbeat.json`,
  );
  try {
    if (existsSync(bridgePath)) {
      return JSON.parse(readFileSync(bridgePath, "utf-8")) as WorkerHeartbeatData;
    }
  } catch {
    // Fall through
  }

  // Try the unified state path
  const statePath = join(
    cwd,
    ".omb",
    "state",
    "team",
    teamName,
    "workers",
    `${workerName}.json`,
  );
  try {
    if (existsSync(statePath)) {
      const raw = JSON.parse(readFileSync(statePath, "utf-8"));
      // Map OMB's WorkerStatus to heartbeat data
      return {
        workerName: raw.name ?? workerName,
        status: raw.alive ? "polling" : "dead",
        lastPollAt: raw.last_turn_at ?? raw.lastHeartbeatAt,
        consecutiveErrors: raw.consecutiveErrors ?? 0,
        currentTaskId: raw.currentTaskId ?? null,
        pid: raw.pid,
      } as WorkerHeartbeatData;
    }
  } catch {
    // Fall through
  }

  return null;
}

// ── Tmux session check ─────────────────────────────────────────────────

function isTmuxSessionAlive(sessionName: string): boolean {
  try {
    const { execSync } = require("child_process");
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Health reports ─────────────────────────────────────────────────────

const DEFAULT_HEARTBEAT_MAX_AGE_MS = 120_000; // 2 minutes

/**
 * Generate health reports for ALL workers in a team.
 * Aggregates heartbeat + tmux + audit log data.
 */
export function getWorkerHealthReports(
  teamName: string,
  cwd: string,
  heartbeatMaxAgeMs: number = DEFAULT_HEARTBEAT_MAX_AGE_MS,
): WorkerHealthReport[] {
  // Discover workers from team state
  const workersDir = join(cwd, ".omb", "state", "team", teamName, "workers");
  const bridgeDir = join(cwd, ".omb", "state", "team-bridge", teamName);

  const workerNames = new Set<string>();

  // Scan workers directory
  if (existsSync(workersDir)) {
    try {
      const { readdirSync } = require("fs");
      for (const file of readdirSync(workersDir)) {
        if (file.endsWith(".json")) {
          workerNames.add(file.replace(/\.json$/, ""));
        }
      }
    } catch {
      // Ignore
    }
  }

  // Scan bridge directory
  if (existsSync(bridgeDir)) {
    try {
      const { readdirSync } = require("fs");
      for (const file of readdirSync(bridgeDir)) {
        const match = file.match(/^(.+)\.heartbeat\.json$/);
        if (match) workerNames.add(match[1]);
      }
    } catch {
      // Ignore
    }
  }

  return Array.from(workerNames).map((name) =>
    checkWorkerHealthReport(teamName, name, cwd, heartbeatMaxAgeMs),
  );
}

/**
 * Generate a single worker's health report.
 */
function checkWorkerHealthReport(
  teamName: string,
  workerName: string,
  cwd: string,
  heartbeatMaxAgeMs: number,
): WorkerHealthReport {
  const heartbeat = readHeartbeatFile(cwd, teamName, workerName);
  const taskCounts = countTaskEvents(cwd, teamName, workerName);

  // Compute heartbeat age
  let heartbeatAgeMs: number | null = null;
  let isAlive = false;
  if (heartbeat?.lastPollAt) {
    const lastPoll = new Date(heartbeat.lastPollAt).getTime();
    if (!isNaN(lastPoll)) {
      heartbeatAgeMs = Date.now() - lastPoll;
      isAlive = heartbeatAgeMs < heartbeatMaxAgeMs;
    }
  }

  // Check tmux session
  const tmuxSessionName = `omb-team-${teamName}`;
  const tmuxAlive = isTmuxSessionAlive(tmuxSessionName);

  // Determine status
  let status: WorkerHealthStatus = "unknown";
  if (heartbeat) {
    const hbStatus = heartbeat.status ?? "";
    if (hbStatus === "quarantined") {
      status = "quarantined";
    } else if (hbStatus === "shutdown") {
      status = "shutdown";
    } else if (!isAlive && !tmuxAlive) {
      status = "dead";
    } else if (hbStatus === "polling" || hbStatus === "ready" || hbStatus === "executing") {
      status = isAlive ? (hbStatus as WorkerHealthStatus) : "dead";
    } else if (!isAlive && tmuxAlive) {
      status = "dead"; // Hung worker
    }
  } else {
    status = tmuxAlive ? "unknown" : "dead";
  }

  // Compute uptime from audit log
  const bridgeStartEvents = (() => {
    try {
      const { readAuditLog: readLog } = require("./audit-log.js");
      return readLog(cwd, teamName, {
        eventType: "bridge_start" as AuditEventType,
        workerName,
        limit: 1,
      });
    } catch {
      return [];
    }
  })();

  let uptimeMs = 0;
  if (bridgeStartEvents.length > 0) {
    const startedAt = new Date(bridgeStartEvents[0].timestamp).getTime();
    if (!isNaN(startedAt)) {
      uptimeMs = Date.now() - startedAt;
    }
  }

  return {
    workerName,
    isAlive,
    tmuxSessionAlive: tmuxAlive,
    heartbeatAgeMs,
    status,
    consecutiveErrors: heartbeat?.consecutiveErrors ?? 0,
    currentTaskId: heartbeat?.currentTaskId ?? null,
    totalTasksCompleted: taskCounts.completed,
    totalTasksFailed: taskCounts.failed + taskCounts.permanentlyFailed,
    uptimeMs,
  };
}

/**
 * Check if a worker needs intervention.
 * Returns the reason string if intervention is needed, null otherwise.
 */
export function checkWorkerHealth(
  teamName: string,
  workerName: string,
  cwd: string,
  heartbeatMaxAgeMs: number = DEFAULT_HEARTBEAT_MAX_AGE_MS,
): HealthCheckResult {
  const report = checkWorkerHealthReport(
    teamName,
    workerName,
    cwd,
    heartbeatMaxAgeMs,
  );

  // Dead + no tmux = definitely needs restart
  if (report.status === "dead" && !report.tmuxSessionAlive) {
    return { needsIntervention: true, reason: "worker is dead" };
  }

  // Dead + tmux alive = hung worker
  if (report.status === "dead" && report.tmuxSessionAlive) {
    return { needsIntervention: true, reason: "worker may be hung (tmux alive, heartbeat stale)" };
  }

  // Quarantined
  if (report.status === "quarantined") {
    return {
      needsIntervention: true,
      reason: `self-quarantined after ${report.consecutiveErrors} consecutive errors`,
    };
  }

  // At risk
  if (report.consecutiveErrors >= 2) {
    return {
      needsIntervention: false,
      reason: `at risk of quarantine (${report.consecutiveErrors} consecutive errors)`,
    };
  }

  return { needsIntervention: false, reason: null };
}
