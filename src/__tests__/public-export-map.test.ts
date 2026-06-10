/**
 * Public export map — regression guard for CR-P1-010 file splitting.
 *
 * This test verifies that all currently exported symbols from the four large
 * files targeted for splitting still exist. When files are split, any missing
 * or renamed export will be caught here before it reaches CI.
 *
 * The test has two layers:
 * 1. Runtime value exports — verified by dynamic import and key presence.
 * 2. Type/interface exports — verified by static source analysis (grep for
 *    `export (interface|type)` declarations). TypeScript interfaces and type
 *    aliases are erased at runtime in ESM and do not appear as namespace keys,
 *    so they must be checked differently.
 *
 * Import map (consumers of each module):
 * - runtime.ts  → cli/team.ts, scripts/team-hardening-benchmark.ts
 * - setup.ts    → index.ts, setup/plan.ts
 * - tmux-session.ts → mcp/team-server.ts, cli/team.ts, cli/autoresearch.ts,
 *                      cli/runtime/bootstrap-context.ts, cli/runtime/launch-pipeline.ts
 * - team.ts     → features/task-decomposer/index.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/__tests__/ → dist/ → project root (where src/ lives)
const projectRoot = join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// runtime.ts exports
// ---------------------------------------------------------------------------

describe('public export map - runtime.ts', () => {
  it('exports expected runtime values', async () => {
    const mod = await import('../team/runtime.js');

    const expectedValueExports = [
      // Functions
      'applyCreatedInteractiveSessionToConfig',
      'shouldPrekillInteractiveShutdownProcessTrees',
      'waitForWorkerStartupEvidence',
      'waitForClaudeStartupEvidence',
      'resolveWorkerLaunchArgsFromEnv',
      'startTeam',
      'monitorTeam',
      'assignTask',
      'reassignTask',
      'shutdownTeam',
      'resumeTeam',
      'sendWorkerMessage',
      'broadcastWorkerMessage',

      // Re-exported values
      'TEAM_LOW_COMPLEXITY_DEFAULT_MODEL',
      'resolveActiveTeamStateRoot',
      'monitorTeamCycle',
      'decideFromSnapshot',
      'TeamLifecycleCoordinator',
    ];

    for (const name of expectedValueExports) {
      assert.ok(name in mod, `runtime.ts should export "${name}"`);
    }
  });

  it('exports expected type/interface declarations in source', () => {
    const source = readFileSync(join(projectRoot, 'src', 'team', 'runtime.ts'), 'utf-8');

    const expectedTypeExports = [
      'TeamSnapshot',
      'TeamRuntime',
      'TeamShutdownSummary',
      'StaleTeamSummary',
      'TeamStartOptions',
      'MonitorCycleResult',
      'MonitorDecision',
      'LifecycleStep',
      'LifecycleResult',
      'LifecycleContext',
    ];

    for (const name of expectedTypeExports) {
      // Match either `export interface/type Name` or `export { type Name }` re-exports
      const pattern = new RegExp(`export\\s+(?:interface|type)\\s+${name}\\b|export\\s*\\{[^}]*type\\s+${name}\\b`);
      assert.ok(pattern.test(source), `runtime.ts should export type "${name}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// setup.ts (cli) exports
// ---------------------------------------------------------------------------

describe('public export map - setup.ts', () => {
  it('exports expected runtime values', async () => {
    const mod = await import('../cli/setup.js');

    const expectedValueExports = [
      // Constants
      'SETUP_SCOPES',
      'SETUP_PROVIDERS',

      // Functions
      'toNeutralScopeDirectories',
      'parseSkillFrontmatter',
      'validateSkillFile',
      'resolveScopeDirectories',
      'setup',
      'installSkills',
    ];

    for (const name of expectedValueExports) {
      assert.ok(name in mod, `setup.ts should export "${name}"`);
    }
  });

  it('exports expected type/interface declarations in source', () => {
    const source = readFileSync(join(projectRoot, 'src', 'cli', 'setup.ts'), 'utf-8');

    const expectedTypeExports = [
      'SetupScope',
      'SetupProvider',
      'ScopeDirectories',
      'ScopeDirectoriesNeutral',
      'SkillFrontmatterMetadata',
    ];

    for (const name of expectedTypeExports) {
      const pattern = new RegExp(`export\\s+(?:interface|type)\\s+${name}\\b|export\\s*\\{[^}]*type\\s+${name}\\b`);
      assert.ok(pattern.test(source), `setup.ts should export type "${name}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// tmux-session.ts exports
// ---------------------------------------------------------------------------

describe('public export map - tmux-session.ts', () => {
  it('exports expected runtime values', async () => {
    const mod = await import('../team/tmux-session.js');

    const expectedValueExports = [
      // Functions
      'hasCurrentTmuxClientContext',
      'isMsysOrGitBash',
      'translatePathForMsys',
      'listPaneIds',
      'chooseTeamLeaderPaneId',
      'sleepFractionalSeconds',
      'buildResizeHookTarget',
      'buildResizeHookName',
      'buildHudPaneTarget',
      'buildRegisterResizeHookArgs',
      'buildUnregisterResizeHookArgs',
      'buildClientAttachedReconcileHookName',
      'buildRegisterClientAttachedReconcileArgs',
      'buildUnregisterClientAttachedReconcileArgs',
      'unregisterResizeHook',
      'buildScheduleDelayedHudResizeArgs',
      'buildReconcileHudResizeArgs',
      'resolveTeamWorkerLaunchMode',
      'resolveTeamWorkerCli',
      'resolveTeamWorkerCliPlan',
      'translateWorkerLaunchArgsForCli',
      'assertTeamWorkerCliBinaryAvailable',
      'buildWorkerStartupCommand',
      'buildWorkerProcessLaunchSpec',
      'sanitizeTeamName',
      'isWsl2',
      'isNativeWindows',
      'isTmuxAvailable',
      'createTeamSession',
      'restoreStandaloneHudPane',
      'enableMouseScrolling',
      'resolveWorkerCliForSend',
      'buildWorkerSubmitPlan',
      'shouldAttemptAdaptiveRetry',
      'waitForWorkerReady',
      'dismissTrustPromptIfPresent',
      'sendToWorkerStdin',
      'sendToWorker',
      'notifyLeaderStatus',
      'getWorkerPanePid',
      'isWorkerAlive',
      'killWorker',
      'killWorkerByPaneId',
      'killWorkerByPaneIdAsync',
      'teardownWorkerPanes',
      'killWorkerPanes',
      'destroyTeamSession',
      'listTeamSessions',
      'notifyLeaderMailboxAsync',

      // Re-exported constants
      'paneIsBootstrapping',
      'paneLooksReady',
      'paneHasActiveTask',
      'normalizeTmuxCapture',
    ];

    for (const name of expectedValueExports) {
      assert.ok(name in mod, `tmux-session.ts should export "${name}"`);
    }
  });

  it('exports expected type/interface declarations in source', () => {
    const source = readFileSync(join(projectRoot, 'src', 'team', 'tmux-session.ts'), 'utf-8');

    const expectedTypeExports = [
      'TeamSession',
      'TeamWorkerCli',
      'TeamWorkerLaunchMode',
      'WorkerSubmitPlan',
      'WorkerProcessLaunchSpec',
      'PaneTeardownSummary',
      'PaneTeardownOptions',
    ];

    for (const name of expectedTypeExports) {
      const pattern = new RegExp(`export\\s+(?:interface|type)\\s+${name}\\b|export\\s*\\{[^}]*type\\s+${name}\\b`);
      assert.ok(pattern.test(source), `tmux-session.ts should export type "${name}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// team.ts (cli) exports
// ---------------------------------------------------------------------------

describe('public export map - team.ts (cli)', () => {
  it('exports expected runtime values', async () => {
    const mod = await import('../cli/team.js');

    const expectedValueExports = [
      // Functions
      'parseTeamStartArgs',
      'buildTeamExecutionPlan',
      'decomposeTaskString',
      'buildLeaderMonitoringHints',
      'teamCommand',
    ];

    for (const name of expectedValueExports) {
      assert.ok(name in mod, `team.ts (cli) should export "${name}"`);
    }
  });

  it('exports expected type/interface declarations in source', () => {
    const source = readFileSync(join(projectRoot, 'src', 'cli', 'team.ts'), 'utf-8');

    const expectedTypeExports = [
      'ParsedTeamStartArgs',
      'DecompositionStrategy',
      'TeamExecutionTask',
      'TeamExecutionPlanMetadata',
      'TeamExecutionPlan',
    ];

    for (const name of expectedTypeExports) {
      const pattern = new RegExp(`export\\s+(?:interface|type)\\s+${name}\\b|export\\s*\\{[^}]*type\\s+${name}\\b`);
      assert.ok(pattern.test(source), `team.ts (cli) should export type "${name}"`);
    }
  });
});
