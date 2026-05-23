/**
 * Session Lifecycle Manager for oh-my-codebuddy
 *
 * Tracks session start/end, detects stale sessions from crashed launches,
 * and provides structured logging for session events.
 */

import { readFile, writeFile, mkdir, unlink, appendFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { ombStateDir, ombLogsDir } from '../utils/paths.js';
import {
  resolveCanonicalStateDir,
  resolveLegacyStateDir,
  shouldDualWrite,
} from '../compat/legacy-boundary.js';
import {
  type ProcessIdentity,
  type ProcessIdentityAdapter,
  getProcessIdentityAdapter,
  normalizeCmdline,
} from '../runtime/process-identity.js';
import { withPathLock } from '../team/state/locks.js';

export type SessionLeaderCli = 'codebuddy' | 'codex' | 'claude';

export interface SessionState {
  session_id: string;
  started_at: string;
  cwd: string;
  pid: number;
  platform?: NodeJS.Platform;
  pid_start_ticks?: number;
  pid_cmdline?: string;
  leader_cli?: SessionLeaderCli;
}

const SESSION_FILE = 'session.json';
const HISTORY_FILE = 'session-history.jsonl';
const SESSION_LOCK_DIR = '.lock.session';
const SESSION_LOCK_STALE_MS = 30_000;
// No age-based threshold: staleness is determined by PID liveness/identity.
// Long-running sessions (>2h) are legitimate and should not be reaped.

function sessionPath(cwd: string): string {
  return join(ombStateDir(cwd), SESSION_FILE);
}

function sessionLockDir(cwd: string): string {
  return join(ombStateDir(cwd), SESSION_LOCK_DIR);
}

function historyPath(cwd: string): string {
  return join(ombLogsDir(cwd), HISTORY_FILE);
}

function legacySessionPath(cwd: string): string {
  return join(resolveLegacyStateDir(cwd), SESSION_FILE);
}

/**
 * Reset session-scoped HUD/metrics files at launch so stale values do not leak
 * into a new CodeBuddy session.
 *
 * Serialized via withPathLock against the session lock dir to prevent
 * concurrent omb launches from interleaving partial metric resets.
 */
export async function resetSessionMetrics(cwd: string): Promise<void> {
  const ombDir = join(cwd, '.omb');
  const stateDir = ombStateDir(cwd);
  await mkdir(ombDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  await withPathLock(
    sessionLockDir(cwd),
    { lockStaleMs: SESSION_LOCK_STALE_MS, label: 'session-metrics' },
    async () => {
      const now = new Date().toISOString();
      await writeFile(join(ombDir, 'metrics.json'), JSON.stringify({
        total_turns: 0,
        session_turns: 0,
        last_activity: now,
        session_input_tokens: 0,
        session_output_tokens: 0,
        session_total_tokens: 0,
        five_hour_limit_pct: 0,
        weekly_limit_pct: 0,
      }, null, 2));

      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_turn_at: now,
        last_progress_at: now,
        turn_count: 0,
        last_agent_output: '',
      }, null, 2));
    },
  );
}

/**
 * Read current session state. Returns null if no session file exists.
 */
export async function readSessionState(cwd: string): Promise<SessionState | null> {
  for (const path of [sessionPath(cwd), legacySessionPath(cwd)]) {
    if (!existsSync(path)) continue;

    try {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content) as SessionState;
    } catch {
      return null;
    }
  }

  return null;
}

interface SessionStaleCheckOptions {
  platform?: NodeJS.Platform;
  isPidAlive?: (pid: number) => boolean;
  readLinuxIdentity?: (pid: number) => ProcessIdentity | null;
  identityAdapter?: ProcessIdentityAdapter;
}

interface SessionStartOptions {
  pid?: number;
  platform?: NodeJS.Platform;
  leaderCli?: SessionLeaderCli;
  staleCheck?: SessionStaleCheckOptions;
}

// Process identity logic has been extracted to src/runtime/process-identity.ts
// Use the adapter interface for testability and platform flexibility.

/**
 * Check if a session is stale.
 * - If the owning PID is dead, it is stale.
 * - On Linux, require process identity validation (start ticks, optional cmdline).
 *   If identity cannot be validated, treat the session as stale.
 */
export function isSessionStale(
  state: SessionState,
  options: SessionStaleCheckOptions = {},
): boolean {
  if (!Number.isInteger(state.pid) || state.pid <= 0) return true;

  const adapter = options.identityAdapter ?? getProcessIdentityAdapter(options.platform);
  const isPidAlive = options.isPidAlive ?? ((pid: number) => adapter.isPidAlive(pid));
  if (!isPidAlive(state.pid)) return true;

  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return false;

  const readIdentity = options.readLinuxIdentity ?? ((pid: number) => adapter.readIdentity(pid));
  const liveIdentity = readIdentity(state.pid);
  if (!liveIdentity) return true;

  if (typeof state.pid_start_ticks !== 'number') return true;
  if (state.pid_start_ticks !== liveIdentity.startTicks) return true;

  const expectedCmdline = normalizeCmdline(state.pid_cmdline);
  if (expectedCmdline) {
    const liveCmdline = normalizeCmdline(liveIdentity.cmdline);
    if (!liveCmdline || liveCmdline !== expectedCmdline) return true;
  }

  return false;
}

async function appendSessionEndArtifacts(
  cwd: string,
  sessionId: string,
  state: SessionState | null,
  reason?: string,
): Promise<void> {
  const endTime = new Date().toISOString();
  const logsDir = ombLogsDir(cwd);
  await mkdir(logsDir, { recursive: true });

  const historyEntry = {
    session_id: sessionId,
    started_at: state?.started_at || 'unknown',
    ended_at: endTime,
    cwd,
    pid: state?.pid || process.pid,
    leader_cli: state?.leader_cli,
    ...(reason ? { reason } : {}),
  };

  await appendFile(historyPath(cwd), JSON.stringify(historyEntry) + '\n');
  await appendToLog(cwd, {
    event: 'session_end',
    session_id: sessionId,
    timestamp: endTime,
    ...(reason ? { reason } : {}),
  });
}

/**
 * Write session start state.
 * Writes to canonical path always; writes to legacy path only when dual-write is active.
 *
 * Serialized via withPathLock so two concurrent launches in the same cwd
 * don't clobber each other's session.json or interleave partial writes.
 */
export async function writeSessionStart(
  cwd: string,
  sessionId: string,
  options: SessionStartOptions = {},
): Promise<void> {
  const stateDir = resolveCanonicalStateDir(cwd);
  await mkdir(stateDir, { recursive: true });

  const dualWriteOmb = shouldDualWrite('.omb');
  if (dualWriteOmb) {
    const legacyDir = resolveLegacyStateDir(cwd);
    await mkdir(legacyDir, { recursive: true });
  }

  const pid = Number.isInteger(options.pid) && options.pid && options.pid > 0
    ? options.pid
    : process.pid;
  const platform = options.platform ?? process.platform;
  const adapter = getProcessIdentityAdapter(platform);
  const linuxIdentity = adapter.readIdentity(pid);

  const state: SessionState = {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    cwd,
    pid,
    platform,
    pid_start_ticks: linuxIdentity?.startTicks,
    pid_cmdline: linuxIdentity?.cmdline ?? undefined,
    leader_cli: options.leaderCli,
  };

  const serialized = JSON.stringify(state, null, 2);
  await withPathLock(
    sessionLockDir(cwd),
    { lockStaleMs: SESSION_LOCK_STALE_MS, label: 'session-start' },
    async () => {
      const existing = await readSessionState(cwd);
      if (existing && existing.session_id !== sessionId && isSessionStale(existing, options.staleCheck)) {
        await appendSessionEndArtifacts(cwd, existing.session_id, existing, 'stale_session_reconciled');
      }

      await writeFile(sessionPath(cwd), serialized);
      if (dualWriteOmb) {
        await writeFile(legacySessionPath(cwd), serialized);
      }
    },
  );
  await appendToLog(cwd, {
    event: 'session_start',
    session_id: sessionId,
    pid,
    timestamp: state.started_at,
  });
}

/**
 * Write session end: archive to history, delete session.json.
 *
 * Read + delete is wrapped in a lock so that a writeSessionStart from a
 * concurrent launch can't race the delete (which would leave the new
 * session orphaned with no session.json on disk).
 */
export async function writeSessionEnd(cwd: string, sessionId: string): Promise<void> {
  const state = await readSessionState(cwd);
  await appendSessionEndArtifacts(cwd, sessionId, state);

  await withPathLock(
    sessionLockDir(cwd),
    { lockStaleMs: SESSION_LOCK_STALE_MS, label: 'session-end' },
    async () => {
      // Delete session.json — only the owning session_id should clear it,
      // so a stale writeSessionEnd from a previous run can't wipe a new
      // session's state file.
      const candidates = [sessionPath(cwd)];
      const legacy = legacySessionPath(cwd);
      if (legacy !== sessionPath(cwd)) candidates.push(legacy);
      for (const path of candidates) {
        try {
          const current = await readFile(path, 'utf-8');
          const parsed = JSON.parse(current) as { session_id?: unknown };
          if (typeof parsed.session_id !== 'string' || parsed.session_id === sessionId) {
            await unlink(path);
          }
        } catch { /* file may already be gone or unreadable */ }
      }
    },
  );

}

/**
 * Append a structured JSONL entry to the daily log file.
 */
export async function appendToLog(cwd: string, entry: Record<string, unknown>): Promise<void> {
  const logsDir = ombLogsDir(cwd);
  await mkdir(logsDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const logFile = join(logsDir, `omb-${date}.jsonl`);
  const line = JSON.stringify({ ...entry, _ts: new Date().toISOString() }) + '\n';

  await appendFile(logFile, line);
}
