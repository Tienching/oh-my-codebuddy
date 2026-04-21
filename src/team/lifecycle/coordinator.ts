import { resolve } from 'path';
import { existsSync } from 'fs';
import type { TeamConfig, WorkerInfo } from '../team-ops.js';
import type { EnsureWorktreeResult } from '../worktree.js';
import {
  teardownWorkerPanes,
  unregisterResizeHook,
  destroyTeamSession,
  killWorkerByPaneIdAsync,
  restoreStandaloneHudPane,
  listPaneIds,
  listTeamSessions,
} from '../tmux-session.js';
import { teamCleanup as cleanupTeamState, teamSaveConfig as saveTeamConfig } from '../team-ops.js';
import { removeTeamWorkerInstructionsFile, removeWorkerWorktreeRootAgentsFile } from '../worker-bootstrap.js';
import { rollbackProvisionedWorktrees } from '../worktree.js';

export type LifecycleStep = 'provision' | 'activate' | 'rollback' | 'shutdown';

export interface LifecycleResult {
  step: LifecycleStep;
  success: boolean;
  errors: string[];
  completedSteps: LifecycleStep[];
}

export interface LifecycleContext {
  teamName: string;
  cwd: string;
  config: TeamConfig;
  provisionedWorktrees: Array<EnsureWorktreeResult | { enabled: false }>;
  workerInstructionsPath: string | null;
  restoreModelInstructionsFile: (teamName: string) => void;
  teardownPromptWorker: (teamName: string, workerName: string, fallbackPid: number | undefined, cwd: string, context: 'startup_rollback' | 'shutdown') => Promise<{ terminated: boolean; error?: string }>;
  terminateProcessTree: (pid: number) => Promise<{ terminated: boolean }>;
  getWorkerPanePid: (sessionName: string, workerIndex: number, paneId: string | undefined) => number | undefined;
  createdWorkerPaneIds: string[];
  createdLeaderPaneId: string | undefined;
  sessionCreated: boolean;
  sessionName: string;
}

export class TeamLifecycleCoordinator {
  private context: LifecycleContext | null = null;
  private completedSteps: LifecycleStep[] = [];

  setContext(context: LifecycleContext): void {
    this.context = context;
    this.completedSteps = [];
  }

  async rollback(failedStep: string): Promise<LifecycleResult> {
    const errors: string[] = [];
    const ctx = this.context;
    if (!ctx) {
      return { step: 'rollback', success: false, errors: ['No lifecycle context set'], completedSteps: [] };
    }

    const { teamName, cwd, config, provisionedWorktrees, workerInstructionsPath, sessionCreated, sessionName, createdWorkerPaneIds, createdLeaderPaneId } = ctx;

    // Unregister resize hook
    if (config.resize_hook_name && config.resize_hook_target) {
      try {
        const unregistered = unregisterResizeHook(config.resize_hook_target, config.resize_hook_name);
        if (!unregistered) {
          errors.push('unregisterResizeHook: returned false');
        }
      } catch (cleanupError) {
        errors.push(`unregisterResizeHook: ${String(cleanupError)}`);
      }
    }

    config.resize_hook_name = null;
    config.resize_hook_target = null;
    try {
      await saveTeamConfig(config, cwd);
    } catch (cleanupError) {
      errors.push(`saveTeamConfig(clear resize hook): ${String(cleanupError)}`);
    }

    // Tear down panes / session
    if (sessionCreated) {
      if (sessionName.includes(':')) {
        for (const [index, paneId] of createdWorkerPaneIds.entries()) {
          const panePid = ctx.getWorkerPanePid(sessionName, index + 1, paneId);
          if (panePid) {
            await ctx.terminateProcessTree(panePid);
          }
          try {
            await killWorkerByPaneIdAsync(paneId, createdLeaderPaneId);
          } catch (err) {
            process.stderr.write(`[team/lifecycle] operation failed: ${err}\n`);
          }
        }
        if (config.hud_pane_id) {
          try {
            await killWorkerByPaneIdAsync(config.hud_pane_id, createdLeaderPaneId);
          } catch (err) {
            process.stderr.write(`[team/lifecycle] operation failed: ${err}\n`);
          }
        }
      } else {
        try {
          destroyTeamSession(sessionName);
        } catch (cleanupError) {
          errors.push(`destroyTeamSession: ${String(cleanupError)}`);
        }
      }
    }

    // Prompt worker teardown
    if (config.worker_launch_mode === 'prompt') {
      const promptTeardownFailures: string[] = [];
      for (const worker of config.workers) {
        const teardown = await ctx.teardownPromptWorker(
          teamName,
          worker.name,
          worker.pid as number | undefined,
          cwd,
          'startup_rollback',
        );
        if (!teardown.terminated) {
          promptTeardownFailures.push(`${worker.name}:${teardown.error || 'unknown_error'}`);
        }
      }
      if (promptTeardownFailures.length > 0) {
        errors.push(`promptTeardown:${promptTeardownFailures.join(',')}`);
      }
    }

    // Remove worker instructions files
    for (const worker of config.workers) {
      if (!worker.worktree_path || !worker.team_state_root) continue;
      try {
        await removeWorkerWorktreeRootAgentsFile(teamName, worker.name, worker.team_state_root, worker.worktree_path);
      } catch (cleanupError) {
        errors.push(`removeWorkerWorktreeRootAgentsFile(${worker.name}): ${String(cleanupError)}`);
      }
    }

    if (workerInstructionsPath) {
      try {
        await removeTeamWorkerInstructionsFile(teamName, cwd);
      } catch (cleanupError) {
        errors.push(`removeTeamWorkerInstructionsFile: ${String(cleanupError)}`);
      }
    }

    ctx.restoreModelInstructionsFile(teamName);

    // Cleanup state
    try {
      await cleanupTeamState(teamName, cwd);
    } catch (cleanupError) {
      errors.push(`cleanupTeamState: ${String(cleanupError)}`);
    }

    // Rollback worktrees
    if (provisionedWorktrees.length > 0) {
      try {
        await rollbackProvisionedWorktrees(provisionedWorktrees, { skipBranchDeletion: false });
      } catch (cleanupError) {
        errors.push(`rollbackProvisionedWorktrees: ${String(cleanupError)}`);
      }
    }

    this.completedSteps.push('rollback');
    return {
      step: 'rollback',
      success: errors.length === 0,
      errors,
      completedSteps: [...this.completedSteps],
    };
  }

  async shutdown(): Promise<LifecycleResult> {
    const errors: string[] = [];
    const ctx = this.context;
    if (!ctx) {
      return { step: 'shutdown', success: false, errors: ['No lifecycle context set'], completedSteps: [] };
    }

    const { teamName, cwd, config, sessionName } = ctx;

    // Interactive pane teardown
    if (config.worker_launch_mode === 'interactive') {
      const leaderPaneId = config.leader_pane_id;
      const hudPaneId = config.hud_pane_id;
      const livePaneIds = listPaneIds(sessionName);

      // Resize hook cleanup
      if (config.resize_hook_name && config.resize_hook_target) {
        const unregistered = unregisterResizeHook(config.resize_hook_target, config.resize_hook_name);
        if (!unregistered) {
          const baseSession = sessionName.split(':')[0];
          const sessionStillActive = listTeamSessions().includes(baseSession);
          if (sessionStillActive) {
            errors.push(`failed to unregister resize hook ${config.resize_hook_name}`);
          }
        }
      }
      config.resize_hook_name = null;
      config.resize_hook_target = null;
      await saveTeamConfig(config, cwd);

      // HUD pane
      let restoredHudPaneId: string | null = null;
      if (hudPaneId) {
        await killWorkerByPaneIdAsync(hudPaneId, leaderPaneId ?? undefined);
        if (sessionName.includes(':')) {
          restoredHudPaneId = restoreStandaloneHudPane(leaderPaneId, cwd);
        }
      }

      // Worker pane teardown
      const shutdownPaneIds = collectShutdownPaneIds({ config, livePaneIds, restoredStandaloneHudPaneId: restoredHudPaneId });
      await teardownWorkerPanes(shutdownPaneIds, {
        leaderPaneId,
        hudPaneId: restoredHudPaneId ?? hudPaneId,
      });

      // Destroy detached session
      if (!sessionName.includes(':')) {
        try {
          destroyTeamSession(sessionName);
        } catch (err) {
          process.stderr.write(`[team/lifecycle] operation failed: ${err}\n`);
        }
      }
    } else {
      // Prompt worker teardown
      const promptTeardownFailures: string[] = [];
      for (const w of config.workers) {
        const teardown = await ctx.teardownPromptWorker(
          teamName,
          w.name,
          w.pid as number | undefined,
          cwd,
          'shutdown',
        );
        if (!teardown.terminated) {
          promptTeardownFailures.push(`${w.name}:${teardown.error || 'unknown_error'}`);
        }
      }
      if (promptTeardownFailures.length > 0) {
        errors.push(`shutdown_prompt_teardown_failed:${promptTeardownFailures.join(',')}`);
      }
    }

    // Remove worker instructions
    for (const worker of config.workers) {
      if (!worker.worktree_path || !worker.team_state_root) continue;
      try {
        await removeWorkerWorktreeRootAgentsFile(teamName, worker.name, worker.team_state_root, worker.worktree_path);
      } catch (err) {
        process.stderr.write(`[team/lifecycle] operation failed: ${err}\n`);
      }
    }

    try {
      await removeTeamWorkerInstructionsFile(teamName, cwd);
    } catch (err) {
      process.stderr.write(`[team/lifecycle] operation failed: ${err}\n`);
    }

    ctx.restoreModelInstructionsFile(teamName);

    // Worktree rollback
    const provisionedWorktrees = collectProvisionedShutdownWorktrees(config);
    if (provisionedWorktrees.length > 0) {
      try {
        await rollbackProvisionedWorktrees(provisionedWorktrees, { skipBranchDeletion: false });
      } catch (err) {
        errors.push(`rollbackProvisionedWorktrees: ${String(err)}`);
      }
    }

    // State cleanup
    try {
      await cleanupTeamState(teamName, cwd);
    } catch (err) {
      errors.push(`cleanupTeamState: ${String(err)}`);
    }

    this.completedSteps.push('shutdown');
    return {
      step: 'shutdown',
      success: errors.length === 0,
      errors,
      completedSteps: [...this.completedSteps],
    };
  }
}

function collectShutdownPaneIds(params: {
  config: TeamConfig;
  livePaneIds?: string[];
  restoredStandaloneHudPaneId?: string | null;
}): string[] {
  const { config, livePaneIds = [], restoredStandaloneHudPaneId = null } = params;
  const excludedPaneIds = new Set(
    [
      config.leader_pane_id,
      config.hud_pane_id,
      restoredStandaloneHudPaneId,
    ].filter((paneId): paneId is string => typeof paneId === 'string' && paneId.trim().startsWith('%')),
  );

  const paneIds = new Set<string>();
  for (const paneId of [
    ...config.workers.map((worker) => worker.pane_id),
    ...livePaneIds,
  ]) {
    if (typeof paneId !== 'string') continue;
    const normalized = paneId.trim();
    if (!normalized.startsWith('%')) continue;
    if (excludedPaneIds.has(normalized)) continue;
    paneIds.add(normalized);
  }

  return [...paneIds];
}

function collectProvisionedShutdownWorktrees(config: TeamConfig): EnsureWorktreeResult[] {
  const seenWorktreePaths = new Set<string>();
  const worktrees: EnsureWorktreeResult[] = [];

  for (const worker of config.workers) {
    if (worker.worktree_created !== true) continue;
    if (worker.worktree_detached !== true) continue;
    if (!worker.worktree_repo_root || !worker.worktree_path) continue;
    if (!existsSync(worker.worktree_path)) continue;

    const worktreePath = resolve(worker.worktree_path);
    if (seenWorktreePaths.has(worktreePath)) continue;
    seenWorktreePaths.add(worktreePath);

    worktrees.push({
      enabled: true,
      repoRoot: worker.worktree_repo_root,
      worktreePath,
      detached: true,
      branchName: null,
      created: true,
      reused: false,
      createdBranch: false,
    });
  }

  return worktrees;
}
