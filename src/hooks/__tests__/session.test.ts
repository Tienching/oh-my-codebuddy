import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resetSessionMetrics,
  writeSessionStart,
  writeSessionEnd,
  readSessionState,
  isSessionStale,
  type SessionState,
} from '../session.js';

interface SessionHistoryEntry {
  session_id: string;
  started_at: string;
  ended_at: string;
  cwd: string;
  pid: number;
  leader_cli?: 'codebuddy' | 'codex' | 'claude';
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: 'sess-1',
    started_at: '2026-02-26T00:00:00.000Z',
    cwd: '/tmp/project',
    pid: 12345,
    ...overrides,
  };
}

describe('session lifecycle manager', () => {
  it('resets session metrics files with zeroed counters', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omb-session-metrics-'));
    try {
      await resetSessionMetrics(cwd);

      const metricsPath = join(cwd, '.omb', 'metrics.json');
      const hudPath = join(cwd, '.omb', 'state', 'hud-state.json');
      assert.equal(existsSync(metricsPath), true);
      assert.equal(existsSync(hudPath), true);

      const metrics = JSON.parse(await readFile(metricsPath, 'utf-8')) as {
        total_turns: number;
        session_turns: number;
      };
      const hud = JSON.parse(await readFile(hudPath, 'utf-8')) as {
        turn_count: number;
      };

      assert.equal(metrics.total_turns, 0);
      assert.equal(metrics.session_turns, 0);
      assert.equal(hud.turn_count, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes session start/end lifecycle artifacts and archives session history', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omb-session-lifecycle-'));
    const sessionId = 'sess-lifecycle-1';
    try {
      await writeSessionStart(cwd, sessionId, { leaderCli: 'claude' });

      const state = await readSessionState(cwd);
      assert.ok(state);
      assert.equal(state.session_id, sessionId);
      assert.equal(state.cwd, cwd);
      assert.equal(state.pid, process.pid);
      assert.equal(state.leader_cli, 'claude');
      assert.equal(isSessionStale(state), false);

      const sessionPath = join(cwd, '.omb', 'state', 'session.json');
      assert.equal(existsSync(sessionPath), true);

      await writeSessionEnd(cwd, sessionId);

      assert.equal(existsSync(sessionPath), false);

      const historyPath = join(cwd, '.omb', 'logs', 'session-history.jsonl');
      assert.equal(existsSync(historyPath), true);

      const historyLines = (await readFile(historyPath, 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.equal(historyLines.length, 1);

      const historyEntry = JSON.parse(historyLines[0]) as SessionHistoryEntry;
      assert.equal(historyEntry.session_id, sessionId);
      assert.equal(historyEntry.cwd, cwd);
      assert.equal(historyEntry.leader_cli, 'claude');
      assert.equal(typeof historyEntry.started_at, 'string');
      assert.equal(typeof historyEntry.ended_at, 'string');

      const dailyLogPath = join(cwd, '.omb', 'logs', `omb-${todayIsoDate()}.jsonl`);
      assert.equal(existsSync(dailyLogPath), true);
      const dailyLog = await readFile(dailyLogPath, 'utf-8');
      assert.match(dailyLog, /"event":"session_start"/);
      assert.match(dailyLog, /"event":"session_end"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('archives stale previous session state before writing a new session start', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omb-session-stale-archive-'));
    try {
      await resetSessionMetrics(cwd);
      const sessionPath = join(cwd, '.omb', 'state', 'session.json');
      await writeFile(sessionPath, JSON.stringify({
        session_id: 'sess-dead',
        started_at: '2026-05-20T08:32:08.456Z',
        cwd,
        pid: 987654321,
        platform: 'linux',
        pid_start_ticks: 123,
        pid_cmdline: 'node /home/ubuntu/.local/bin/omb --madmax',
        leader_cli: 'codebuddy',
      }, null, 2));

      await writeSessionStart(cwd, 'sess-new', {
        pid: process.pid,
        leaderCli: 'claude',
        staleCheck: {
          platform: 'linux',
          isPidAlive: () => false,
        },
      } as any);

      const state = await readSessionState(cwd);
      assert.ok(state);
      assert.equal(state.session_id, 'sess-new');

      const historyPath = join(cwd, '.omb', 'logs', 'session-history.jsonl');
      const historyLines = (await readFile(historyPath, 'utf-8')).trim().split('\n').filter(Boolean);
      assert.equal(historyLines.length, 1);
      const archived = JSON.parse(historyLines[0]) as SessionHistoryEntry & { reason?: string };
      assert.equal(archived.session_id, 'sess-dead');
      assert.equal(archived.reason, 'stale_session_reconciled');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does NOT archive existing session when isPidAlive returns true (still alive, not stale)', async () => {
    // Negative path: a future regression that always archives (e.g.
    // dropping the isSessionStale gate) would otherwise pass the existing
    // positive test silently. This pins the gate.
    //
    // Use platform='darwin' so isSessionStale relies purely on isPidAlive
    // (linux additionally requires pid_start_ticks/cmdline checks via
    // readLinuxIdentity, which would need adapter mocking).
    const cwd = await mkdtemp(join(tmpdir(), 'omb-session-alive-noarchive-'));
    try {
      await resetSessionMetrics(cwd);
      const sessionPath = join(cwd, '.omb', 'state', 'session.json');
      await writeFile(sessionPath, JSON.stringify({
        session_id: 'sess-alive',
        started_at: '2026-05-20T08:32:08.456Z',
        cwd,
        pid: 987654321,
        platform: 'darwin',
        pid_cmdline: 'node /home/ubuntu/.local/bin/omb --madmax',
        leader_cli: 'codebuddy',
      }, null, 2));

      await writeSessionStart(cwd, 'sess-new', {
        pid: process.pid,
        leaderCli: 'claude',
        staleCheck: {
          platform: 'darwin',
          isPidAlive: () => true,
        },
      } as any);

      const historyPath = join(cwd, '.omb', 'logs', 'session-history.jsonl');
      // history file should not exist OR be empty — nothing to archive.
      const historyExists = existsSync(historyPath);
      if (historyExists) {
        const content = (await readFile(historyPath, 'utf-8')).trim();
        assert.equal(content, '', 'expected no archived history entries when previous session is still alive');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does NOT archive when existing session_id matches the incoming sessionId (idempotent re-write)', async () => {
    // Negative path: re-writing the same session must not duplicate-archive
    // it as if it were a stale predecessor.
    const cwd = await mkdtemp(join(tmpdir(), 'omb-session-idempotent-'));
    try {
      await resetSessionMetrics(cwd);
      const sessionPath = join(cwd, '.omb', 'state', 'session.json');
      await writeFile(sessionPath, JSON.stringify({
        session_id: 'sess-same',
        started_at: '2026-05-20T08:32:08.456Z',
        cwd,
        pid: 987654321,
        platform: 'darwin',
        pid_cmdline: 'node /home/ubuntu/.local/bin/omb',
        leader_cli: 'codebuddy',
      }, null, 2));

      await writeSessionStart(cwd, 'sess-same', {
        pid: process.pid,
        leaderCli: 'codebuddy',
        staleCheck: {
          platform: 'darwin',
          // even with isPidAlive=false, same session_id means no archival
          isPidAlive: () => false,
        },
      } as any);

      const historyPath = join(cwd, '.omb', 'logs', 'session-history.jsonl');
      const historyExists = existsSync(historyPath);
      if (historyExists) {
        const content = (await readFile(historyPath, 'utf-8')).trim();
        assert.equal(content, '', 'expected no archived history entries when session_id is unchanged');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats invalid session JSON as absent state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omb-session-invalid-'));
    try {
      const statePath = join(cwd, '.omb', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, '{ not-json', 'utf-8');
      const state = await readSessionState(cwd);
      assert.equal(state, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks dead PIDs as stale', () => {
    const impossiblePid = Number.MAX_SAFE_INTEGER;
    const stale = isSessionStale({
      session_id: 'sess-stale',
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      pid: impossiblePid,
    });
    assert.equal(stale, true);
  });
});

describe('isSessionStale', () => {
  it('returns false for a live Linux process when identity matches', () => {
    const state = makeState({
      pid_start_ticks: 111,
      pid_cmdline: 'node omb',
    });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 111, cmdline: 'node omb' }),
    });

    assert.equal(stale, false);
  });

  it('returns true for PID reuse on Linux when start ticks mismatch', () => {
    const state = makeState({
      pid_start_ticks: 111,
      pid_cmdline: 'node omb',
    });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 222, cmdline: 'node omb' }),
    });

    assert.equal(stale, true);
  });

  it('returns true on Linux when identity metadata is missing', () => {
    const state = makeState();

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 111, cmdline: 'node omb' }),
    });

    assert.equal(stale, true);
  });

  it('returns true on Linux when live identity cannot be read', () => {
    const state = makeState({ pid_start_ticks: 111 });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => null,
    });

    assert.equal(stale, true);
  });

  it('returns true when PID is not alive', () => {
    const state = makeState({ pid_start_ticks: 111 });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => false,
    });

    assert.equal(stale, true);
  });

  it('falls back to PID liveness on non-Linux platforms', () => {
    const state = makeState();

    const stale = isSessionStale(state, {
      platform: 'darwin',
      isPidAlive: () => true,
      readLinuxIdentity: () => null,
    });

    assert.equal(stale, false);
  });
});

describe('session writes are serialized via withPathLock', () => {
  it('two concurrent writeSessionStart calls do not corrupt session.json', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omb-session-lock-'));
    try {
      // Race two concurrent writeSessionStart with different sessionIds.
      // Without locking the file could be torn or contain a mix.
      // With the path lock, it must end up as a valid JSON whose session_id
      // matches one of the inputs (last writer wins, but no garbage).
      const a = writeSessionStart(cwd, 'sess-A', { pid: 1001 });
      const b = writeSessionStart(cwd, 'sess-B', { pid: 1002 });
      await Promise.all([a, b]);

      const state = await readSessionState(cwd);
      assert.ok(state, 'session.json must exist after concurrent writes');
      assert.match(state!.session_id, /^sess-(A|B)$/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeSessionEnd only deletes session.json owned by the matching sessionId', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omb-session-end-'));
    try {
      // Session A starts.
      await writeSessionStart(cwd, 'sess-A', { pid: 2001 });
      // Session B starts (overwrites A's session.json).
      await writeSessionStart(cwd, 'sess-B', { pid: 2002 });
      // A late writeSessionEnd from session A should NOT delete session B's
      // session.json — the owner-id check inside writeSessionEnd guards this.
      await writeSessionEnd(cwd, 'sess-A');

      const state = await readSessionState(cwd);
      assert.ok(state, 'session.json must still exist (B owns it)');
      assert.equal(state!.session_id, 'sess-B', 'B must not be wiped by stale A end');

      // Now end the real owner — this should clear it.
      await writeSessionEnd(cwd, 'sess-B');
      const after = await readSessionState(cwd);
      assert.equal(after, null, 'session.json must be gone after owning sessionEnd');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resetSessionMetrics holds the session lock end-to-end', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omb-session-metrics-'));
    try {
      // Concurrent resets must not produce a torn metrics.json.
      const a = resetSessionMetrics(cwd);
      const b = resetSessionMetrics(cwd);
      await Promise.all([a, b]);

      const metrics = JSON.parse(await readFile(join(cwd, '.omb', 'metrics.json'), 'utf8'));
      assert.equal(metrics.total_turns, 0);
      assert.equal(metrics.session_turns, 0);
      assert.ok(typeof metrics.last_activity === 'string');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
