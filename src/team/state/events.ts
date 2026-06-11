import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TeamEvent } from './types.js';
import { withPathLock } from './locks.js';
import { isWakeableTeamEventType } from '../contracts.js';
import { teamEventLogPath, appendTeamEvent } from '../state.js';

interface TeamEventReadOptions {
  afterEventId?: string;
  wakeableOnly?: boolean;
  type?: TeamEvent['type'] | 'worker_idle';
  worker?: string;
  taskId?: string;
}

export interface TeamEventReadDiagnostics {
  after_event_id: string | null;
  cursor_found: boolean;
  cursor_missing: boolean;
  malformed_line_count: number;
  invalid_event_count: number;
  latest_available_cursor: string;
  read_error: string | null;
}

export interface TeamEventReadResult {
  events: TeamEvent[];
  cursor: string;
  diagnostics: TeamEventReadDiagnostics;
}

export type WaitForTeamEventResult =
  | { status: 'event'; event: TeamEvent; cursor: string; diagnostics: TeamEventReadDiagnostics }
  | { status: 'timeout'; cursor: string; diagnostics: TeamEventReadDiagnostics }
  | { status: 'cursor_missing'; cursor: string; diagnostics: TeamEventReadDiagnostics };

function asWorkerState(value: unknown): TeamEvent['state'] | undefined {
  return typeof value === 'string'
    && ['idle', 'working', 'blocked', 'done', 'failed', 'draining', 'unknown'].includes(value)
    ? value as TeamEvent['state']
    : undefined;
}

function normalizeRawTeamEvent(raw: unknown): TeamEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const eventId = typeof value.event_id === 'string' ? value.event_id.trim() : '';
  const team = typeof value.team === 'string' ? value.team.trim() : '';
  const type = typeof value.type === 'string' ? value.type.trim() : '';
  const worker = typeof value.worker === 'string' ? value.worker.trim() : '';
  const createdAt = typeof value.created_at === 'string' ? value.created_at.trim() : '';
  if (!eventId || !team || !type || !worker || !createdAt) return null;

  if (type === 'worker_idle') {
    return {
      ...(value as TeamEvent),
      event_id: eventId,
      team,
      type: 'worker_state_changed',
      source_type: 'worker_idle',
      worker,
      state: 'idle',
      prev_state: asWorkerState(value.prev_state),
      created_at: createdAt,
    };
  }

  return {
    ...(value as TeamEvent),
    event_id: eventId,
    team,
    type: type as TeamEvent['type'],
    worker,
    task_id: typeof value.task_id === 'string' ? value.task_id : undefined,
    message_id: typeof value.message_id === 'string' || value.message_id === null ? value.message_id as string | null : undefined,
    reason: typeof value.reason === 'string' ? value.reason : undefined,
    state: asWorkerState(value.state),
    prev_state: asWorkerState(value.prev_state),
    worker_count: typeof value.worker_count === 'number' ? value.worker_count : undefined,
    to_worker: typeof value.to_worker === 'string' ? value.to_worker : undefined,
    source_type: typeof value.source_type === 'string' ? value.source_type : undefined,
    created_at: createdAt,
  };
}

function isDuplicateNormalizedEvent(previous: TeamEvent | null, current: TeamEvent): boolean {
  if (!previous) return false;
  if (previous.type !== 'worker_state_changed' || current.type !== 'worker_state_changed') return false;
  return previous.team === current.team
    && previous.worker === current.worker
    && previous.task_id === current.task_id
    && previous.state === current.state
    && previous.prev_state === current.prev_state
    && current.source_type === 'worker_idle';
}

function matchesEventType(event: TeamEvent, type: TeamEventReadOptions['type']): boolean {
  if (!type) return true;
  if (event.type === type) return true;
  return type === 'worker_idle' && event.source_type === 'worker_idle';
}

function matchesEventQuery(event: TeamEvent, opts: TeamEventReadOptions): boolean {
  if (!matchesEventType(event, opts.type)) return false;
  if (opts.worker && event.worker !== opts.worker) return false;
  if (opts.taskId && event.task_id !== opts.taskId) return false;
  return true;
}

function buildReadDiagnostics(afterEventId?: string): TeamEventReadDiagnostics {
  return {
    after_event_id: afterEventId ?? null,
    cursor_found: !afterEventId,
    cursor_missing: false,
    malformed_line_count: 0,
    invalid_event_count: 0,
    latest_available_cursor: '',
    read_error: null,
  };
}

function eventLogLockDir(logPath: string): string {
  return join(dirname(logPath), '.lock.events');
}

function eventLogLockLabel(teamName: string): string {
  return `team event log ${teamName}`;
}

function eventLogLockOptions(teamName: string) {
  return {
    label: eventLogLockLabel(teamName),
    lockStaleMs: 300_000,
    acquireTimeoutMs: 10_000,
  };
}

// ── Rotation ──────────────────────────────────────────────────────────

const DEFAULT_MAX_EVENT_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Rotate the team event log if it exceeds the size limit.
 * Keeps the most recent half of entries. Uses atomic write via temp file.
 */
export async function rotateTeamEventLog(
  teamName: string,
  cwd: string,
  maxBytes: number = DEFAULT_MAX_EVENT_LOG_SIZE_BYTES,
): Promise<boolean> {
  const path = teamEventLogPath(teamName, cwd);
  if (!existsSync(path)) return false;

  return await withPathLock(eventLogLockDir(path), eventLogLockOptions(teamName), async () => {
    if (!existsSync(path)) return false;

    try {
      const stats = await stat(path);
      if (stats.size <= maxBytes) return false;

      const content = await readFile(path, 'utf8');
      const lines = content.trim().split('\n').filter((line) => line.trim().length > 0);
      if (lines.length < 2) return false;

      const keepCount = Math.ceil(lines.length / 2);
      const kept = lines.slice(-keepCount);

      const tmp = join(dirname(path), `events-rotate-${randomUUID()}.tmp`);
      await writeFile(tmp, kept.join('\n') + '\n', 'utf8');
      await rename(tmp, path);
      return true;
    } catch {
      return false;
    }
  });
}

// ── Read ─────────────────────────────────────────────────────────────

export async function readTeamEventsDetailed(
  teamName: string,
  cwd: string,
  opts: TeamEventReadOptions = {},
): Promise<TeamEventReadResult> {
  const path = teamEventLogPath(teamName, cwd);
  const diagnostics = buildReadDiagnostics(opts.afterEventId);
  if (!existsSync(path)) {
    return { events: [], cursor: '', diagnostics };
  }

  return await withPathLock(eventLogLockDir(path), eventLogLockOptions(teamName), async () => {
    if (!existsSync(path)) {
      return { events: [], cursor: '', diagnostics };
    }

    let raw = '';
    try {
      raw = await readFile(path, 'utf-8');
    } catch (error) {
      diagnostics.read_error = (error as Error).message;
      return { events: [], cursor: '', diagnostics };
    }

    if (!raw.trim()) {
      return { events: [], cursor: '', diagnostics };
    }

    const events: TeamEvent[] = [];
    let started = !opts.afterEventId;
    let previous: TeamEvent | null = null;
    let latestCursor = '';

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        diagnostics.malformed_line_count += 1;
        continue;
      }
      const normalized = normalizeRawTeamEvent(parsed);
      if (!normalized) {
        diagnostics.invalid_event_count += 1;
        continue;
      }
      latestCursor = normalized.event_id;
      diagnostics.latest_available_cursor = normalized.event_id;
      if (!started) {
        if (normalized.event_id === opts.afterEventId) {
          started = true;
          diagnostics.cursor_found = true;
        }
        continue;
      }
      if (isDuplicateNormalizedEvent(previous, normalized)) continue;
      previous = normalized;
      if (opts.wakeableOnly && !isWakeableTeamEventType(normalized.type)) continue;
      if (!matchesEventQuery(normalized, opts)) continue;
      events.push(normalized);
    }

    diagnostics.cursor_missing = Boolean(opts.afterEventId) && !diagnostics.cursor_found && latestCursor !== '';
    return { events, cursor: latestCursor, diagnostics };
  });
}

export async function readTeamEvents(
  teamName: string,
  cwd: string,
  opts: TeamEventReadOptions = {},
): Promise<TeamEvent[]> {
  return (await readTeamEventsDetailed(teamName, cwd, opts)).events;
}

export async function getLatestTeamEventCursor(teamName: string, cwd: string): Promise<string> {
  const result = await readTeamEventsDetailed(teamName, cwd);
  return result.cursor;
}

export async function waitForTeamEvent(
  teamName: string,
  cwd: string,
  opts: {
    afterEventId?: string;
    timeoutMs: number;
    pollMs?: number;
    wakeableOnly?: boolean;
    type?: TeamEvent['type'] | 'worker_idle';
    worker?: string;
    taskId?: string;
  },
): Promise<WaitForTeamEventResult> {
  const deadline = Date.now() + Math.max(0, Math.floor(opts.timeoutMs));
  let pollMs = Math.max(25, Math.floor(opts.pollMs ?? 100));
  const baseline = opts.afterEventId ?? await getLatestTeamEventCursor(teamName, cwd);
  let lastDiagnostics = buildReadDiagnostics(baseline || undefined);

  while (Date.now() <= deadline) {
    const result = await readTeamEventsDetailed(teamName, cwd, {
      afterEventId: baseline || undefined,
      wakeableOnly: opts.wakeableOnly !== false,
      type: opts.type,
      worker: opts.worker,
      taskId: opts.taskId,
    });
    lastDiagnostics = result.diagnostics;
    const event = result.events[0];
    if (event) {
      return { status: 'event', event, cursor: event.event_id, diagnostics: result.diagnostics };
    }
    if (result.diagnostics.cursor_missing) {
      return { status: 'cursor_missing', cursor: baseline, diagnostics: result.diagnostics };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    pollMs = Math.min(Math.floor(pollMs * 1.5), 500);
  }

  return { status: 'timeout', cursor: baseline, diagnostics: lastDiagnostics };
}

export { appendTeamEvent };
