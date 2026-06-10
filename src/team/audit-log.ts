/**
 * Audit Log - Append-only JSONL event log for team operations
 *
 * Records team lifecycle events (bridge start/shutdown, task lifecycle,
 * worker health, permission violations) in a structured JSONL format.
 * Supports filtered reads, size-based rotation, and permission-restricted
 * file writing.
 *
 * Complements OMB's existing event log (state/events.ts) by adding
 * MCP-specific event types and rotation support.
 *
 */

import { existsSync, readFileSync } from "fs";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

// ── Types ──────────────────────────────────────────────────────────────

export type AuditEventType =
  | "bridge_start"
  | "bridge_shutdown"
  | "worker_ready"
  | "task_claimed"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "task_permanently_failed"
  | "worker_quarantined"
  | "worker_idle"
  | "inbox_rotated"
  | "outbox_rotated"
  | "cli_spawned"
  | "cli_timeout"
  | "cli_error"
  | "shutdown_received"
  | "shutdown_ack"
  | "permission_violation"
  | "permission_audit";

export interface AuditEvent {
  timestamp: string;
  event_type: AuditEventType;
  team_name: string;
  worker_name?: string;
  task_id?: string;
  details?: string;
  [key: string]: unknown;
}

export interface AuditLogFilter {
  eventType?: AuditEventType;
  workerName?: string;
  since?: string; // ISO timestamp
  limit?: number;
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const FILE_MODE = 0o600; // Owner read/write only
let rotationCounter = 0;

// ── Path helpers ───────────────────────────────────────────────────────

function auditLogPath(cwd: string, teamName: string): string {
  return join(cwd, ".omb", "logs", `team-bridge-${teamName}.jsonl`);
}

function logsDir(cwd: string): string {
  return join(cwd, ".omb", "logs");
}

// ── Write ──────────────────────────────────────────────────────────────

/** Append an audit event to the team's JSONL log. */
export async function logAuditEvent(
  cwd: string,
  event: AuditEvent,
): Promise<void> {
  const fullEvent: AuditEvent = {
    ...event,
    timestamp: event.timestamp || new Date().toISOString(),
  };

  const dir = logsDir(cwd);
  await mkdir(dir, { recursive: true });
  await appendFile(
    auditLogPath(cwd, fullEvent.team_name),
    JSON.stringify(fullEvent) + "\n",
    { mode: FILE_MODE },
  );

  // Check rotation after write (only every 50th write to reduce overhead)
  rotationCounter++;
  if (rotationCounter % 50 === 0) {
    try {
      await rotateAuditLog(cwd, fullEvent.team_name);
    } catch { /* rotation failure is non-critical */ }
  }
}

// ── Read ───────────────────────────────────────────────────────────────

/** Read audit log with optional filters. Supports early-exit on limit. */
export function readAuditLog(
  cwd: string,
  teamName: string,
  filter?: AuditLogFilter,
): AuditEvent[] {
  const path = auditLogPath(cwd, teamName);
  if (!existsSync(path)) return [];

  try {
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const results: AuditEvent[] = [];

    // Iterate in reverse for efficient limit-based early exit
    const startIdx = filter?.limit ? Math.max(0, lines.length - filter.limit) : 0;

    for (let i = startIdx; i < lines.length; i++) {
      let event: AuditEvent;
      try {
        event = JSON.parse(lines[i]) as AuditEvent;
      } catch {
        continue;
      }

      // Apply filters
      if (filter?.eventType && event.event_type !== filter.eventType) continue;
      if (filter?.workerName && event.worker_name !== filter.workerName) continue;
      if (filter?.since && event.timestamp < filter.since) continue;

      results.push(event);
    }

    return results;
  } catch {
    return [];
  }
}

// ── Rotation ───────────────────────────────────────────────────────────

/**
 * Rotate the audit log if it exceeds the size limit.
 * Keeps the most recent half of entries. Uses atomic write via temp file.
 */
export async function rotateAuditLog(
  cwd: string,
  teamName: string,
  maxSizeBytes: number = DEFAULT_MAX_LOG_SIZE_BYTES,
): Promise<boolean> {
  const path = auditLogPath(cwd, teamName);
  if (!existsSync(path)) return false;

  try {
    const { stat } = await import("fs/promises");
    const stats = await stat(path);
    if (stats.size < maxSizeBytes) return false;

    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n").filter(Boolean);

    // Keep most recent half
    const keepCount = Math.ceil(lines.length / 2);
    const kept = lines.slice(-keepCount);

    // Write to temp file, then atomic rename
    const tempPath = join(logsDir(cwd), `audit-rotate-${randomUUID()}.tmp`);

    // Symlink attack prevention: delete if symlink
    if (existsSync(tempPath)) {
      try {
        const { lstatSync } = require("fs");
        if (lstatSync(tempPath).isSymbolicLink()) {
          await unlink(tempPath);
        }
      } catch {
        // Ignore
      }
    }

    await writeFile(tempPath, kept.join("\n") + "\n", { mode: FILE_MODE });
    await rename(tempPath, path);

    return true;
  } catch {
    return false;
  }
}

// ── Task count helpers ─────────────────────────────────────────────────

/** Count completed and failed tasks from the audit log. */
export function countTaskEvents(
  cwd: string,
  teamName: string,
  workerName?: string,
): {
  completed: number;
  failed: number;
  permanentlyFailed: number;
} {
  const events = readAuditLog(cwd, teamName, { workerName });

  let completed = 0;
  let failed = 0;
  let permanentlyFailed = 0;

  for (const event of events) {
    if (workerName && event.worker_name !== workerName) continue;
    switch (event.event_type) {
      case "task_completed":
        completed++;
        break;
      case "task_failed":
        failed++;
        break;
      case "task_permanently_failed":
        permanentlyFailed++;
        break;
    }
  }

  return { completed, failed, permanentlyFailed };
}
