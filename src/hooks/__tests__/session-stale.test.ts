import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSessionStale, type SessionState } from '../session.js';
import {
  LinuxProcessIdentityAdapter,
  FallbackProcessIdentityAdapter,
  normalizeCmdline,
  parseLinuxProcStartTicks,
} from '../../runtime/process-identity.js';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: 'sess-test',
    started_at: '2026-04-21T00:00:00.000Z',
    cwd: '/tmp/project',
    pid: 12345,
    ...overrides,
  };
}

describe('isSessionStale — process identity contract', () => {
  // ── PID dead → stale ───────────────────────────────────────────────

  it('returns stale when PID is dead', () => {
    const state = makeState({ pid: 99999999 });
    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => false,
      readLinuxIdentity: () => null,
    });
    assert.equal(stale, true);
  });

  it('returns stale for PID 0 or negative', () => {
    assert.equal(isSessionStale(makeState({ pid: 0 })), true);
    assert.equal(isSessionStale(makeState({ pid: -1 })), true);
  });

  it('returns stale for non-integer PID', () => {
    assert.equal(isSessionStale(makeState({ pid: 1.5 as number })), true);
  });

  // ── PID reused (startTicks mismatch) → stale ──────────────────────

  it('returns stale when start ticks mismatch (PID reuse)', () => {
    const state = makeState({
      pid_start_ticks: 100,
      pid_cmdline: 'node omb',
    });
    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 999, cmdline: 'node omb' }),
    });
    assert.equal(stale, true);
  });

  // ── cmdline mismatch → stale ──────────────────────────────────────

  it('returns stale when cmdline mismatches', () => {
    const state = makeState({
      pid_start_ticks: 100,
      pid_cmdline: 'node omb',
    });
    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 100, cmdline: 'python script.py' }),
    });
    assert.equal(stale, true);
  });

  // ── cmdline missing → not stale (matching startTicks) ──────────────

  it('returns NOT stale when cmdline is absent but startTicks match', () => {
    const state = makeState({
      pid_start_ticks: 100,
      // No pid_cmdline — session state didn't capture cmdline
    });
    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 100, cmdline: 'node omb' }),
    });
    assert.equal(stale, false);
  });

  it('returns NOT stale when cmdline is empty string but startTicks match', () => {
    const state = makeState({
      pid_start_ticks: 100,
      pid_cmdline: '',
    });
    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 100, cmdline: 'node omb' }),
    });
    assert.equal(stale, false);
  });

  it('returns NOT stale when cmdline is null but startTicks match', () => {
    const state = makeState({
      pid_start_ticks: 100,
      pid_cmdline: null as unknown as string,
    });
    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 100, cmdline: 'node omb' }),
    });
    assert.equal(stale, false);
  });

  // ── Non-Linux passthrough ──────────────────────────────────────────

  it('returns NOT stale on non-Linux if PID is alive (no identity check)', () => {
    const state = makeState({
      // No pid_start_ticks — would be stale on Linux
    });
    const stale = isSessionStale(state, {
      platform: 'darwin',
      isPidAlive: () => true,
    });
    assert.equal(stale, false);
  });

  it('returns stale on non-Linux if PID is dead', () => {
    const state = makeState();
    const stale = isSessionStale(state, {
      platform: 'darwin',
      isPidAlive: () => false,
    });
    assert.equal(stale, true);
  });

  it('returns NOT stale on win32 if PID is alive', () => {
    const state = makeState();
    const stale = isSessionStale(state, {
      platform: 'win32',
      isPidAlive: () => true,
    });
    assert.equal(stale, false);
  });

  // ── pid_start_ticks missing → stale on Linux ──────────────────────

  it('returns stale on Linux when pid_start_ticks is missing', () => {
    const state = makeState({
      // pid_start_ticks intentionally omitted
      pid_cmdline: 'node omb',
    });
    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 100, cmdline: 'node omb' }),
    });
    assert.equal(stale, true);
  });

  it('returns stale on Linux when pid_start_ticks is undefined', () => {
    const state = makeState({
      pid_start_ticks: undefined,
      pid_cmdline: 'node omb',
    });
    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 100, cmdline: 'node omb' }),
    });
    assert.equal(stale, true);
  });

  // ── Live identity cannot be read → stale on Linux ─────────────────

  it('returns stale on Linux when live identity cannot be read', () => {
    const state = makeState({
      pid_start_ticks: 100,
      pid_cmdline: 'node omb',
    });
    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => null,
    });
    assert.equal(stale, true);
  });

  // ── Exact match → not stale ───────────────────────────────────────

  it('returns NOT stale when PID alive, startTicks match, and cmdline matches', () => {
    const state = makeState({
      pid_start_ticks: 100,
      pid_cmdline: 'node omb',
    });
    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 100, cmdline: 'node omb' }),
    });
    assert.equal(stale, false);
  });

  // ── Malformed session.json handling ────────────────────────────────

  it('returns stale for state with invalid PID type', () => {
    const state = makeState({ pid: NaN });
    assert.equal(isSessionStale(state), true);
  });

  it('handles cmdline with extra whitespace normalization', () => {
    const state = makeState({
      pid_start_ticks: 100,
      pid_cmdline: '  node   omb  ',
    });
    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 100, cmdline: 'node omb' }),
    });
    // Both are normalized, so they should match
    assert.equal(stale, false);
  });

  // ── ProcessIdentityAdapter integration ─────────────────────────────

  it('uses LinuxProcessIdentityAdapter when no overrides provided on linux', () => {
    // This tests the adapter factory path — the adapter itself will try
    // /proc/{pid}/stat which won't exist for our test PID, so identity
    // will be null → stale on Linux.
    const state = makeState({
      pid: 99999999, // Doesn't exist
      pid_start_ticks: 100,
    });
    const stale = isSessionStale(state, { platform: 'linux' });
    // PID is dead → stale regardless
    assert.equal(stale, true);
  });

  it('uses FallbackProcessIdentityAdapter on darwin', () => {
    // Note: FallbackProcessIdentityAdapter is used on darwin, but the PID liveness
    // check still uses process.kill(pid, 0). makeState() uses pid: 12345 which
    // may not exist, so we explicitly use process.pid for a known-alive PID.
    const state = makeState({ pid: process.pid });
    const stale = isSessionStale(state, { platform: 'darwin' });
    // Current process PID is alive, fallback adapter skips identity check on darwin
    assert.equal(stale, false);
  });
});

describe('process-identity helpers', () => {
  // ── normalizeCmdline ───────────────────────────────────────────────

  it('normalizes whitespace in cmdline', () => {
    assert.equal(normalizeCmdline('  node   omb  '), 'node omb');
  });

  it('returns null for null input', () => {
    assert.equal(normalizeCmdline(null), null);
  });

  it('returns null for undefined input', () => {
    assert.equal(normalizeCmdline(undefined), null);
  });

  it('returns null for empty string', () => {
    assert.equal(normalizeCmdline(''), null);
  });

  it('returns null for whitespace-only string', () => {
    assert.equal(normalizeCmdline('   '), null);
  });

  // ── parseLinuxProcStartTicks ───────────────────────────────────────

  it('parses start ticks from valid /proc/pid/stat content', () => {
    // Simulated stat line: pid (comm) state ppid pgrp session tty_nr tpgid flags
    // minflt cminflt majflt cmajflt utime stime cutime cstime priority nice
    // num_threads itrealvalue starttime [field 22, 0-indexed 19 after comm]
    const stat = '12345 (node) S 1 12345 12345 0 -1 4194304 100 0 0 0 5 3 0 0 20 0 1 0 9876543 0';
    const ticks = parseLinuxProcStartTicks(stat);
    assert.equal(ticks, 9876543);
  });

  it('returns null for malformed stat content', () => {
    assert.equal(parseLinuxProcStartTicks('no parenthesis'), null);
  });

  it('returns null when not enough fields after comm', () => {
    assert.equal(parseLinuxProcStartTicks('(node) S 1 2'), null);
  });

  it('returns null for non-numeric starttime field', () => {
    // starttime is at fields[19] (0-indexed after comm)
    // Put 'abc' at position 19 so it becomes fields[19]
    const stat = '(node) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 abc 19';
    assert.equal(parseLinuxProcStartTicks(stat), null);
  });

  // ── FallbackProcessIdentityAdapter ─────────────────────────────────

  it('FallbackProcessIdentityAdapter.readIdentity always returns null', () => {
    const adapter = new FallbackProcessIdentityAdapter();
    assert.equal(adapter.readIdentity(process.pid), null);
    assert.equal(adapter.readIdentity(1), null);
  });

  it('FallbackProcessIdentityAdapter.isPidAlive works for current PID', () => {
    const adapter = new FallbackProcessIdentityAdapter();
    assert.equal(adapter.isPidAlive(process.pid), true);
  });

  it('FallbackProcessIdentityAdapter.isPidAlive returns false for dead PID', () => {
    const adapter = new FallbackProcessIdentityAdapter();
    assert.equal(adapter.isPidAlive(99999999), false);
  });
});
