/**
 * Merge Orchestrator — US-003
 * Three-tier merge strategy: leader-online / cli-interactive / non-interactive.
 * Wraps all state mutations in withMergeLock to prevent concurrent runs.
 */

import { execFile, execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { promisify } from 'util';
import { withMergeLock } from './state/locks.js';
import {
  type ConflictReport,
  type MergeFlowOptions,
  type MergeFlowResult,
  type MergeSessionState,
  type MergeTier,
  type MergeWorkerEntry,
  mergeSessionPath,
  readMergeSession,
  writeMergeSession,
  writeConflictReport,
} from './merge-session.js';
import { checkMergeConflicts, mergeWorkerBranch } from './merge-coordinator.js';
import { appendTeamEvent, readTeamConfig } from './state.js';
import { isPaneIdle as _isPaneIdle } from './idle-nudge.js';
import {
  notifyLeaderMailboxAsync,
  sanitizeTeamName,
  sendToWorker,
} from './tmux-session.js';
import { removeWorktreeForce } from './worktree.js';
import { resolveActiveTeamStateRoot } from './state-root.js';
import { waitForTeamEvent, getLatestTeamEventCursor } from './state/events.js';

// Re-export for callers that need them through this module
export { readMergeSession, writeMergeSession } from './merge-session.js';

// ── Internal aliases ───────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

// ── Lock deps ──────────────────────────────────────────────────────────────

/** TeamPathDeps shape expected by withMergeLock (and other lock helpers). */
const LOCK_DEPS = {
  teamDir: (name: string, cwd: string): string =>
    join(resolveActiveTeamStateRoot(cwd), 'team', name),
  taskClaimLockDir: (name: string, taskId: string, cwd: string): string =>
    join(resolveActiveTeamStateRoot(cwd), 'team', name, 'claims', `task-${taskId}.lock`),
  mailboxLockDir: (name: string, worker: string, cwd: string): string =>
    join(resolveActiveTeamStateRoot(cwd), 'team', name, 'mailbox', `.lock-${worker}`),
};

/** Default stale lock timeout: 5 minutes. */
const LOCK_STALE_MS = 300_000;

/** Safe branch name regex — prevents command injection in branch deletion. */
const SAFE_BRANCH_RE = /^[a-zA-Z0-9/_\-.]+$/;

// ── Public exports ─────────────────────────────────────────────────────────

/**
 * Detect the appropriate merge tier for the given team.
 *
 * - `leader-online`    : tmux session exists AND leader pane is idle/ready
 * - `cli-interactive`  : no idle leader pane, but stdin is a TTY
 * - `non-interactive`  : fallback (CI / batch / detached)
 */
export async function detectMergeTier(teamName: string, cwd: string): Promise<MergeTier> {
  try {
    const config = await readTeamConfig(teamName, cwd);
    if (config?.tmux_session) {
      // ENOENT-safe tmux detection
      try {
        await execFileAsync('tmux', ['has-session', '-t', config.tmux_session]);
        // Session exists — check whether leader pane is idle
        if (config.leader_pane_id) {
          try {
            const idle = await _isPaneIdle(config.leader_pane_id);
            if (idle) return 'leader-online';
          } catch {
            // pane check failed — fall through to cli-interactive check
          }
        }
      } catch {
        // tmux not running or session not found — continue
      }
    }
  } catch {
    // readTeamConfig failed — continue
  }

  return process.stdin.isTTY ? 'cli-interactive' : 'non-interactive';
}

/**
 * Remove the git worktree for a successfully merged worker.
 * Non-fatal — callers should catch and log if desired.
 */
export async function cleanupMergedWorker(
  worktreePath: string,
  repoRoot: string,
): Promise<void> {
  await removeWorktreeForce(repoRoot, worktreePath);
}

/**
 * Run the full merge flow for a team, serialised by withMergeLock.
 */
export async function runMergeFlow(options: MergeFlowOptions): Promise<MergeFlowResult> {
  const { teamName, cwd } = options;

  const config = await readTeamConfig(teamName, cwd);
  if (!config) throw new Error(`Team "${teamName}" not found`);

  const repoRoot = config.leader_cwd ?? cwd;

  // ── Resolve tier ───────────────────────────────────────────────────────
  let tier: MergeTier;
  switch (options.mode) {
    case 'leader-online':
      tier = 'leader-online';
      break;
    case 'cli-interactive':
      tier = 'cli-interactive';
      break;
    case 'non-interactive':
      tier = 'non-interactive';
      break;
    default:
      tier = await detectMergeTier(teamName, cwd);
  }

  // ── Resolve base branch ────────────────────────────────────────────────
  const baseBranch = options.baseBranch ?? (await autoDetectBase(repoRoot));

  const sessionPath = mergeSessionPath(teamName, cwd);

  // ── FIX 6 (AC-17): Delegated early return (before lock) ───────────────
  // If detach AND tier is leader-online, delegate to the leader pane and return immediately.
  if (options.detach && tier === 'leader-online') {
    await appendTeamEvent(
      teamName,
      {
        type: 'merge_session_started',
        worker: 'leader-fixed',
        metadata: { tier, baseBranch, delegated: true },
      },
      cwd,
    ).catch(() => undefined);

    await notifyLeaderMailboxAsync(
      teamName,
      'merge-orchestrator',
      `merge delegated: ${baseBranch} detach=true`,
      cwd,
    ).catch(() => undefined);

    return {
      success: true,
      delegated: true,
      tier: 'leader-online',
      sessionPath,
      merged: [],
      conflicts: [],
      skipped: [],
      failed: [],
    };
  }

  // ── FIX 1 (AC-2/AC-3): Dry-run early return (before lock) ─────────────
  // Run conflict checks without merging, without acquiring the lock, without session writes.
  if (options.dryRun) {
    // Build worker list mirroring the logic inside the lock
    const dryWorkers: MergeWorkerEntry[] = config.workers.map((w) => ({
      name: w.name,
      branch: w.worktree_branch ?? `feature/${sanitizeTeamName(teamName)}-${w.name}`,
      worktreePath: w.worktree_path ?? null,
      status: 'pending' as const,
    }));

    // Apply --only filter
    const dryFiltered = options.onlyWorker
      ? dryWorkers.map((w) =>
          w.name === options.onlyWorker ? w : { ...w, status: 'skipped' as const },
        )
      : dryWorkers;

    const dryConflicts: string[] = [];

    process.stdout.write(`merge tier=${tier} success=true\n`);

    for (const worker of dryFiltered) {
      if (worker.status === 'skipped') continue;
      const conflictCheck = checkMergeConflicts(worker.branch, baseBranch, repoRoot);
      if (conflictCheck.hasConflicts) {
        const files = conflictCheck.conflictingFiles.join(',');
        process.stdout.write(`conflict: worker=${worker.name} files=${files}\n`);
        dryConflicts.push(worker.name);
      }
    }

    return {
      success: true,
      tier,
      sessionPath,
      merged: [],
      conflicts: dryConflicts,
      skipped: [],
      failed: [],
    };
  }

  return withMergeLock(teamName, cwd, LOCK_STALE_MS, LOCK_DEPS, async () => {
    // ── Resume: read existing session ──────────────────────────────────
    let existingSession: MergeSessionState | null = null;
    if (options.mode === 'resume') {
      existingSession = await readMergeSession(teamName, cwd);
    }

    // ── Build worker list ──────────────────────────────────────────────
    const allWorkers: MergeWorkerEntry[] = config.workers.map((w) => {
      const existing = existingSession?.workers.find((ew) => ew.name === w.name);
      if (existing) {
        // Re-open conflict workers for retry on resume
        if (existing.status === 'conflict' || existing.status === 'pending' || existing.status === 'merging') {
          return { ...existing, status: 'pending' as const };
        }
        // Keep terminal statuses as-is
        return existing;
      }
      return {
        name: w.name,
        branch: w.worktree_branch ?? `feature/${sanitizeTeamName(teamName)}-${w.name}`,
        worktreePath: w.worktree_path ?? null,
        status: 'pending' as const,
      };
    });

    // Apply --only filter
    const workers: MergeWorkerEntry[] = options.onlyWorker
      ? allWorkers.map((w) =>
          w.name === options.onlyWorker ? w : { ...w, status: 'skipped' as const },
        )
      : allWorkers;

    // ── Initialise session state ───────────────────────────────────────
    const activeSession: MergeSessionState = existingSession
      ? {
          ...existingSession,
          status: 'in_progress',
          tier,
          workers,
          updatedAt: new Date().toISOString(),
        }
      : {
          version: 1,
          teamName,
          baseBranch,
          tier,
          status: 'in_progress',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          workers,
          options: {
            cleanup: options.cleanup,
            detach: options.detach,
            dryRun: options.dryRun,
            only: options.onlyWorker,
            nonInteractive: options.nonInteractive ?? tier === 'non-interactive',
            resume: options.mode === 'resume',
          },
        };

    await writeMergeSession(activeSession, cwd);

    // Emit start event
    await appendTeamEvent(
      teamName,
      {
        type: 'merge_session_started',
        worker: 'leader-fixed',
        metadata: { tier, baseBranch, workerCount: workers.length },
      },
      cwd,
    ).catch(() => undefined);

    // ── Run tier-specific merge loop ───────────────────────────────────
    const pendingWorkers = workers.filter(
      (w) => w.status === 'pending' || w.status === 'merging',
    );

    let result: LoopResult;
    if (tier === 'leader-online') {
      if (activeSession.options.detach) {
        const workerPanes = new Map<string, WorkerPaneInfo>();
        for (const w of config.workers) {
          workerPanes.set(w.name, { index: w.index, paneId: w.pane_id });
        }
        result = await runTier1MergeLoop(
          activeSession,
          pendingWorkers,
          baseBranch,
          repoRoot,
          cwd,
          config.tmux_session,
          workerPanes,
        );
      } else {
        await notifyLeaderMailboxAsync(
          teamName,
          'merge-orchestrator',
          'Leader-online attached merge falls back to inline orchestration for deterministic completion.',
          cwd,
        ).catch(() => undefined);
        result = await runTier3MergeLoop(activeSession, pendingWorkers, baseBranch, repoRoot, cwd);
      }
    } else if (tier === 'cli-interactive') {
      result = await runTier2MergeLoop(activeSession, pendingWorkers, baseBranch, repoRoot, cwd);
    } else {
      result = await runTier3MergeLoop(activeSession, pendingWorkers, baseBranch, repoRoot, cwd);
    }

    // Include statically-skipped workers in final skipped list
    const staticSkipped = workers
      .filter((w) => w.status === 'skipped')
      .map((w) => w.name)
      .filter((n) => !result.skipped.includes(n));
    const allSkipped = [...result.skipped, ...staticSkipped];

    const overallSuccess = result.conflicts.length === 0 && result.failed.length === 0;
    const finalStatus = overallSuccess
      ? ('completed' as const)
      : result.conflicts.length > 0
        ? ('paused' as const)
        : ('failed' as const);

    // Persist final session status
    const latestSession = await readMergeSession(teamName, cwd);
    if (latestSession) {
      await writeMergeSession(
        { ...latestSession, status: finalStatus, completedAt: new Date().toISOString() },
        cwd,
      ).catch(() => undefined);
    }

    // Emit completion event
    await appendTeamEvent(
      teamName,
      {
        type: 'merge_session_completed',
        worker: 'leader-fixed',
        metadata: {
          tier,
          merged: result.merged,
          conflicts: result.conflicts,
          failed: result.failed,
          skipped: allSkipped,
          success: overallSuccess,
        },
      },
      cwd,
    ).catch(() => undefined);

    // ── FIX 3 (AC-4): Write result.json ───────────────────────────────
    const resultPath = await writeResultFile(
      cwd,
      teamName,
      baseBranch,
      tier,
      activeSession.startedAt,
      overallSuccess,
      result.merged,
      result.conflicts,
      allSkipped,
      result.failed,
      activeSession.options?.cleanup ?? false,
      result.worktreesRemoved,
      result.branchesDeleted,
    );

    return {
      success: overallSuccess,
      tier,
      sessionPath,
      resultPath,
      merged: result.merged,
      conflicts: result.conflicts,
      skipped: allSkipped,
      failed: result.failed,
    };
  });
}

// ── Internal helpers ───────────────────────────────────────────────────────

interface LoopResult {
  merged: string[];
  conflicts: string[];
  skipped: string[];
  failed: string[];
  worktreesRemoved: string[];
  branchesDeleted: string[];
}

interface WorkerPaneInfo {
  index: number;
  paneId?: string;
}

async function autoDetectBase(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: repoRoot, encoding: 'utf-8' },
    );
    const branch = stdout.trim().replace(/^origin\//, '');
    if (branch) return branch;
  } catch {}
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: repoRoot, encoding: 'utf-8' },
    );
    const branch = stdout.trim();
    if (branch && branch !== 'HEAD') return branch;
  } catch {}
  return 'main';
}

function buildConflictReport(
  teamName: string,
  workerName: string,
  branch: string,
  baseBranch: string,
  conflictingFiles: string[],
): ConflictReport {
  return {
    conflictId: `conflict-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    teamName,
    workerName,
    branch,
    baseBranch,
    conflictingFiles,
    mergeTreeOutput: conflictingFiles.map((f) => `CONFLICT (content): Merge conflict in ${f}`).join('\n'),
    suggestedCommands: [
      `git checkout ${baseBranch}`,
      `git merge ${branch}`,
      `# Resolve conflicts in: ${conflictingFiles.join(', ')}`,
      `git add .`,
      `git commit`,
      `omb team merge ${teamName} --resume --only ${workerName}`,
    ],
    createdAt: new Date().toISOString(),
  };
}

async function updateWorkerStatus(
  session: MergeSessionState,
  workerName: string,
  updates: Partial<MergeWorkerEntry>,
  cwd: string,
): Promise<MergeSessionState> {
  const updated: MergeSessionState = {
    ...session,
    workers: session.workers.map((w) =>
      w.name === workerName ? { ...w, ...updates } : w,
    ),
  };
  await writeMergeSession(updated, cwd);
  return updated;
}

/**
 * Write result.json to the merge session directory.
 * FIX 3 (AC-4).
 */
async function writeResultFile(
  cwd: string,
  teamName: string,
  baseBranch: string,
  tier: MergeTier,
  startedAt: string,
  success: boolean,
  merged: string[],
  conflicts: string[],
  skipped: string[],
  failed: string[],
  cleanup: boolean,
  worktreesRemoved: string[],
  branchesDeleted: string[],
): Promise<string> {
  const sessionDir = dirname(mergeSessionPath(teamName, cwd));
  await mkdir(sessionDir, { recursive: true });
  const resultPath = join(sessionDir, 'result.json');

  const data = {
    version: 1,
    teamName,
    baseBranch,
    tier,
    startedAt,
    completedAt: new Date().toISOString(),
    success,
    merged,
    conflicts,
    skipped,
    failed,
    cleanup,
    worktreesRemoved,
    branchesDeleted,
  };

  await writeFile(resultPath, JSON.stringify(data, null, 2), 'utf8');
  return resultPath;
}

// ── Tier 3: non-interactive ────────────────────────────────────────────────

async function runTier3MergeLoop(
  sessionIn: MergeSessionState,
  workers: MergeWorkerEntry[],
  baseBranch: string,
  repoRoot: string,
  cwd: string,
): Promise<LoopResult> {
  let session = sessionIn;
  const merged: string[] = [];
  const conflicts: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const worktreesRemoved: string[] = [];
  const branchesDeleted: string[] = [];

  // FIX 2 (AC-5): Indexed for-loop so we can break and mark remaining as skipped
  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];

    if (worker.status === 'skipped') {
      skipped.push(worker.name);
      continue;
    }

    session = await updateWorkerStatus(
      session,
      worker.name,
      { status: 'merging', startedAt: new Date().toISOString() },
      cwd,
    );

    try {
      const conflictCheck = checkMergeConflicts(worker.branch, baseBranch, repoRoot);

      if (conflictCheck.hasConflicts) {
        const report = buildConflictReport(
          session.teamName,
          worker.name,
          worker.branch,
          baseBranch,
          conflictCheck.conflictingFiles,
        );
        const { markdownPath } = await writeConflictReport(report, session.teamName, cwd);
        session = await updateWorkerStatus(
          session,
          worker.name,
          {
            status: 'conflict',
            conflictReportPath: markdownPath,
            completedAt: new Date().toISOString(),
          },
          cwd,
        );
        conflicts.push(worker.name);

        await appendTeamEvent(
          session.teamName,
          {
            type: 'merge_session_progress',
            worker: worker.name,
            metadata: { status: 'conflict', branch: worker.branch, conflictReportPath: markdownPath },
          },
          cwd,
        ).catch(() => undefined);

        // FIX 2 (AC-5): Stop-on-first-failure — mark all remaining workers as skipped
        const remaining = workers.slice(i + 1).filter((w) => w.status !== 'skipped');
        for (const rem of remaining) {
          session = await updateWorkerStatus(session, rem.name, { status: 'skipped' }, cwd);
          skipped.push(rem.name);
        }
        break;
      }

      const mergeResult = mergeWorkerBranch(worker.branch, baseBranch, repoRoot);

      if (!mergeResult.success) {
        session = await updateWorkerStatus(
          session,
          worker.name,
          { status: 'failed', completedAt: new Date().toISOString() },
          cwd,
        );
        failed.push(worker.name);

        await appendTeamEvent(
          session.teamName,
          {
            type: 'merge_session_progress',
            worker: worker.name,
            metadata: { status: 'failed', branch: worker.branch, conflicts: mergeResult.conflicts },
          },
          cwd,
        ).catch(() => undefined);

        // FIX 2 (AC-5): Stop-on-first-failure — mark all remaining workers as skipped
        const remaining = workers.slice(i + 1).filter((w) => w.status !== 'skipped');
        for (const rem of remaining) {
          session = await updateWorkerStatus(session, rem.name, { status: 'skipped' }, cwd);
          skipped.push(rem.name);
        }
        break;
      }

      session = await updateWorkerStatus(
        session,
        worker.name,
        {
          status: 'merged',
          mergeCommit: mergeResult.mergeCommit,
          completedAt: new Date().toISOString(),
        },
        cwd,
      );
      merged.push(worker.name);

      // FIX 4 (AC-8): Cleanup worktree ONLY if session.options.cleanup is true
      if (session.options?.cleanup && worker.worktreePath) {
        await cleanupMergedWorker(worker.worktreePath, repoRoot).catch(() => undefined);
        worktreesRemoved.push(worker.worktreePath);
      }

      // FIX 4 (AC-8): Delete worker branch ONLY if cleanup is true and branch name is safe
      if (session.options?.cleanup && SAFE_BRANCH_RE.test(worker.branch)) {
        try {
          execFileSync('git', ['branch', '-D', worker.branch], {
            cwd: repoRoot,
            stdio: 'pipe',
          });
          branchesDeleted.push(worker.branch);
        } catch {
          // Non-fatal: branch deletion failure does not fail the merge
        }
      }

      await appendTeamEvent(
        session.teamName,
        {
          type: 'merge_session_progress',
          worker: worker.name,
          metadata: { status: 'merged', branch: worker.branch, mergeCommit: mergeResult.mergeCommit },
        },
        cwd,
      ).catch(() => undefined);
    } catch (err: unknown) {
      session = await updateWorkerStatus(
        session,
        worker.name,
        { status: 'failed', completedAt: new Date().toISOString() },
        cwd,
      );
      failed.push(worker.name);

      await appendTeamEvent(
        session.teamName,
        {
          type: 'merge_session_progress',
          worker: worker.name,
          metadata: {
            status: 'failed',
            branch: worker.branch,
            error: err instanceof Error ? err.message : String(err),
          },
        },
        cwd,
      ).catch(() => undefined);

      // FIX 2 (AC-5): Stop-on-first-failure — mark all remaining workers as skipped
      const remaining = workers.slice(i + 1).filter((w) => w.status !== 'skipped');
      for (const rem of remaining) {
        session = await updateWorkerStatus(session, rem.name, { status: 'skipped' }, cwd);
        skipped.push(rem.name);
      }
      break;
    }
  }

  return { merged, conflicts, skipped, failed, worktreesRemoved, branchesDeleted };
}

// ── Tier 2: cli-interactive ────────────────────────────────────────────────

/**
 * Tier 2 mirrors Tier 3 git operations. Future: prompt for conflict resolution.
 */
async function runTier2MergeLoop(
  session: MergeSessionState,
  workers: MergeWorkerEntry[],
  baseBranch: string,
  repoRoot: string,
  cwd: string,
): Promise<LoopResult> {
  return runTier3MergeLoop(session, workers, baseBranch, repoRoot, cwd);
}

// ── Tier 1: leader-online ──────────────────────────────────────────────────

/**
 * Try to dispatch a merge notification to a worker pane.
 * Returns 'dispatched' if the worker received it, 'fallback' otherwise.
 * AC-16: idle precheck gating — only sends if pane is idle.
 */
async function dispatchToWorkerOrFallback(
  tmuxSession: string,
  worker: MergeWorkerEntry,
  paneInfo: WorkerPaneInfo | undefined,
  baseBranch: string,
): Promise<'dispatched' | 'fallback'> {
  if (!paneInfo?.paneId) return 'fallback';

  try {
    // AC-16: idle precheck before sendToWorker
    const idle = await _isPaneIdle(paneInfo.paneId);
    if (!idle) return 'fallback';

    // Keep text short (<200 chars) per sendToWorker contract
    const msg = `merge ${worker.branch} -> ${baseBranch}`;
    if (msg.length > 180) return 'fallback';

    await sendToWorker(tmuxSession, paneInfo.index, msg, paneInfo.paneId);
    return 'dispatched';
  } catch {
    return 'fallback';
  }
}

async function runTier1MergeLoop(
  sessionIn: MergeSessionState,
  workers: MergeWorkerEntry[],
  baseBranch: string,
  repoRoot: string,
  cwd: string,
  tmuxSession: string,
  workerPanes: Map<string, WorkerPaneInfo>,
): Promise<LoopResult> {
  let session = sessionIn;
  const merged: string[] = [];
  const conflicts: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const worktreesRemoved: string[] = [];
  const branchesDeleted: string[] = [];

  // FIX 5 (AC-11): Capture event cursor BEFORE dispatching any workers
  const beforeCursor = await getLatestTeamEventCursor(session.teamName, cwd);

  const dispatchedWorkers: MergeWorkerEntry[] = [];

  for (const worker of workers) {
    if (worker.status === 'skipped') {
      skipped.push(worker.name);
      continue;
    }

    const paneInfo = workerPanes.get(worker.name);
    const dispatched = await dispatchToWorkerOrFallback(
      tmuxSession,
      worker,
      paneInfo,
      baseBranch,
    );

    if (dispatched === 'dispatched') {
      // Mark as merging; completion is only recorded after session state confirms it.
      session = await updateWorkerStatus(
        session,
        worker.name,
        { status: 'merging', startedAt: new Date().toISOString() },
        cwd,
      );
      dispatchedWorkers.push(worker);

      await notifyLeaderMailboxAsync(
        session.teamName,
        'merge-orchestrator',
        `Dispatched merge for ${worker.name} (${worker.branch} → ${baseBranch})`,
        cwd,
      ).catch(() => undefined);
    } else {
      // Fallback: merge directly in this process (tier 3 path)
      const fallback = await runTier3MergeLoop(session, [worker], baseBranch, repoRoot, cwd);
      merged.push(...fallback.merged);
      conflicts.push(...fallback.conflicts);
      skipped.push(...fallback.skipped);
      failed.push(...fallback.failed);
      worktreesRemoved.push(...fallback.worktreesRemoved);
      branchesDeleted.push(...fallback.branchesDeleted);

      // Refresh session from disk after tier 3 writes
      const refreshed = await readMergeSession(session.teamName, cwd);
      if (refreshed) session = refreshed;
    }
  }

  // Detached leader-online runs return before reaching this function. If this
  // path is reused in the future, only record completed workers after reading
  // confirmed session state; any workers still pending fall back to inline merge.
  const shouldWait = !(sessionIn.options?.detach ?? false) && dispatchedWorkers.length > 0;
  if (shouldWait) {
    await waitForTeamEvent(session.teamName, cwd, {
      type: 'merge_session_completed',
      timeoutMs: 300_000,
      afterEventId: beforeCursor,
    });

    const refreshed = await readMergeSession(session.teamName, cwd);
    if (refreshed) session = refreshed;

    const stillPending = dispatchedWorkers.filter((w) => {
      const sw = session.workers.find((s) => s.name === w.name);
      if (sw?.status === 'merged') {
        if (!merged.includes(w.name)) merged.push(w.name);
        return false;
      }
      if (sw?.status === 'conflict') {
        if (!conflicts.includes(w.name)) conflicts.push(w.name);
        return false;
      }
      if (sw?.status === 'failed') {
        if (!failed.includes(w.name)) failed.push(w.name);
        return false;
      }
      if (sw?.status === 'skipped') {
        if (!skipped.includes(w.name)) skipped.push(w.name);
        return false;
      }
      return true;
    });

    if (stillPending.length > 0) {
      const fallback = await runTier3MergeLoop(session, stillPending, baseBranch, repoRoot, cwd);
      merged.push(...fallback.merged.filter((name) => !merged.includes(name)));
      conflicts.push(...fallback.conflicts.filter((name) => !conflicts.includes(name)));
      skipped.push(...fallback.skipped.filter((name) => !skipped.includes(name)));
      failed.push(...fallback.failed.filter((name) => !failed.includes(name)));
      worktreesRemoved.push(...fallback.worktreesRemoved);
      branchesDeleted.push(...fallback.branchesDeleted);
    }
  }

  // Post-loop: notify leader with summary
  if (merged.length > 0 || conflicts.length > 0 || failed.length > 0) {
    await notifyLeaderMailboxAsync(
      session.teamName,
      'merge-orchestrator',
      `Merge summary: ${merged.length} merged, ${conflicts.length} conflicts, ${failed.length} failed`,
      cwd,
    ).catch(() => undefined);
  }

  return { merged, conflicts, skipped, failed, worktreesRemoved, branchesDeleted };
}
