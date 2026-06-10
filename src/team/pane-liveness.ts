/**
 * Pane Liveness Detection — abstracted for Windows/MSYS/tmux boundary compatibility.
 *
 * The original `isWorkerAlive` in tmux-session.ts used `process.kill(pid, 0)` which
 * doesn't work correctly on Windows/MSYS (permission errors on valid processes) or
 * when the signalling process lacks permissions. This module introduces structured
 * liveness states and a merge algorithm that combines multiple detection sources:
 *
 *   - tmux `pane_dead` format string
 *   - tmux `pane_pid` format string
 *   - `process.kill(pid, 0)` probe (with error classification)
 *   - Heartbeat freshness (future: provider heartbeat)
 *
 * Priority: tmux_pane_dead > process_probe > heartbeat > tmux_pane_pid
 */

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Possible liveness states for a tmux pane/worker.
 */
export type PaneLivenessState = 'alive' | 'dead' | 'unknown' | 'stale';

/**
 * Result of a liveness check.
 */
export interface PaneLivenessResult {
  state: PaneLivenessState;
  /** Which sources contributed to this determination */
  sources: PaneLivenessSource[];
  /** Diagnostic details */
  details: string;
}

export interface PaneLivenessSource {
  method: 'tmux_pane_dead' | 'tmux_pane_pid' | 'process_probe' | 'heartbeat';
  raw: string;
  timestamp: string;
}

// ── Error classification ───────────────────────────────────────────────

/**
 * Classify process.kill(pid, 0) errors.
 * ESRCH = process doesn't exist (dead)
 * EPERM = permission denied (unknown/alive — process exists but we can't signal it)
 * EINVAL = invalid pid (dead)
 */
export function classifyProcessProbeError(error: NodeJS.ErrnoException): PaneLivenessState {
  if (error.code === 'ESRCH') return 'dead';
  if (error.code === 'EPERM') return 'unknown';  // Process exists but we can't signal it
  if (error.code === 'EINVAL') return 'dead';     // Invalid PID
  return 'unknown';
}

// ── Process probe ──────────────────────────────────────────────────────

/**
 * Probe whether a process is alive using process.kill(pid, 0).
 * Returns liveness state.
 */
export function probeProcessLiveness(pid: number): PaneLivenessState {
  if (!pid || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return classifyProcessProbeError(error as NodeJS.ErrnoException);
  }
}

// ── Signal merge ───────────────────────────────────────────────────────

/**
 * Merge multiple liveness signals into a final state.
 * Priority: dead > alive (unanimous) > stale > unknown
 *
 * - If any source says 'dead', trust it (process is gone).
 * - If all sources agree on 'alive', trust it.
 * - If we have mixed signals with 'unknown', report 'unknown'.
 * - If we have 'stale' but no 'dead', report 'stale'.
 */
export function mergeLivenessSignals(signals: PaneLivenessState[]): PaneLivenessState {
  if (signals.length === 0) return 'unknown';

  // If any source says 'dead', trust it
  if (signals.includes('dead')) return 'dead';
  // If all sources agree on 'alive', trust it
  if (signals.every(s => s === 'alive')) return 'alive';
  // If we have mixed signals, report 'unknown'
  if (signals.includes('unknown')) return 'unknown';
  // If we have 'stale' but no 'dead', report 'stale'
  if (signals.includes('stale')) return 'stale';

  return 'unknown';
}
