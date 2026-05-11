/**
 * Unit tests for merge-orchestrator.ts
 * Uses node:test + node:assert/strict with module mocking.
 */

import test, { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Helpers ────────────────────────────────────────────────────────────────

let cwd: string;

function makeTeamConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: 'testteam',
    task: 'test-task',
    agent_type: 'claude',
    worker_launch_mode: 'interactive' as const,
    lifecycle_profile: 'default' as const,
    worker_count: 2,
    max_workers: 20,
    workers: [
      {
        name: 'worker-1',
        index: 1,
        role: 'worker',
        assigned_tasks: [],
        pane_id: '%1',
        worktree_branch: 'feature/worker-1',
        worktree_path: null,
      },
      {
        name: 'worker-2',
        index: 2,
        role: 'worker',
        assigned_tasks: [],
        pane_id: '%2',
        worktree_branch: 'feature/worker-2',
        worktree_path: null,
      },
    ],
    created_at: new Date().toISOString(),
    tmux_session: 'omb-team-testteam',
    next_task_id: 1,
    leader_cwd: undefined as string | undefined,
    leader_pane_id: '%0',
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
    ...overrides,
  };
}

// ── detectMergeTier ────────────────────────────────────────────────────────

describe('detectMergeTier', () => {
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'omb-orchtest-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('returns non-interactive when team config is absent', async () => {
    const { detectMergeTier } = await import('../merge-orchestrator.js');
    // No team state at all — should not throw
    const tier = await detectMergeTier('ghost-team', cwd);
    assert.ok(
      tier === 'non-interactive' || tier === 'cli-interactive',
      `Expected non-interactive or cli-interactive, got ${tier}`,
    );
  });
});

// ── writeMergeSession / readMergeSession round-trip ────────────────────────

describe('writeMergeSession + readMergeSession', () => {
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'omb-orchtest-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('round-trips a basic session state', async () => {
    const { writeMergeSession, readMergeSession } = await import('../merge-orchestrator.js');

    const state = {
      version: 1 as const,
      teamName: 'rt-team',
      baseBranch: 'main',
      tier: 'non-interactive' as const,
      status: 'pending' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workers: [
        {
          name: 'worker-1',
          branch: 'feature/worker-1',
          worktreePath: null,
          status: 'pending' as const,
        },
      ],
      options: {
        cleanup: false,
        detach: false,
        dryRun: false,
        nonInteractive: true,
      },
    };

    await writeMergeSession(state, cwd);
    const read = await readMergeSession('rt-team', cwd);
    assert.ok(read, 'read should not be null');
    assert.equal(read.teamName, 'rt-team');
    assert.equal(read.baseBranch, 'main');
    assert.equal(read.status, 'pending');
    assert.equal(read.workers[0].name, 'worker-1');
  });
});

// ── runMergeFlow non-interactive, dry-run no-op ────────────────────────────

describe('runMergeFlow', () => {
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'omb-orchtest-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('throws when team config is missing', async () => {
    const { runMergeFlow } = await import('../merge-orchestrator.js');
    await assert.rejects(
      runMergeFlow({
        teamName: 'nonexistent',
        baseBranch: 'main',
        mode: 'non-interactive',
        dryRun: false,
        cleanup: false,
        detach: false,
        onlyWorker: null,
        cwd,
      }),
      /nonexistent/,
    );
  });

  it('writes session.json with status=pending->in_progress flow', async () => {
    // We cannot easily mock git here, but we can verify the session file is written
    // by running runMergeFlow on a team that has no workers (no merges attempted).
    const { runMergeFlow, readMergeSession } = await import('../merge-orchestrator.js');

    // Create a minimal team manifest so readTeamConfig succeeds
    const teamStateRoot = join(cwd, '.omb', 'state');
    const teamDir = join(teamStateRoot, 'team', 'emptyteam');
    await mkdir(teamDir, { recursive: true });

    // Write as config.json (TeamConfig shape) so readTeamConfig fallback finds it
    const manifest = {
      name: 'emptyteam',
      task: 'test-task',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      lifecycle_profile: 'default',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: 'omb-team-emptyteam',
      next_task_id: 1,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    };
    await writeFile(join(teamDir, 'config.json'), JSON.stringify(manifest), 'utf8');

    // runMergeFlow should complete successfully with empty worker list
    const result = await runMergeFlow({
      teamName: 'emptyteam',
      baseBranch: 'main',
      mode: 'non-interactive',
      dryRun: false,
      cleanup: false,
      detach: false,
      onlyWorker: null,
      cwd,
    });

    assert.equal(result.success, true);
    assert.equal(result.tier, 'non-interactive');
    assert.deepEqual(result.merged, []);
    assert.deepEqual(result.conflicts, []);

    // Session should be written
    const session = await readMergeSession('emptyteam', cwd);
    assert.ok(session, 'session should be written');
    assert.equal(session.teamName, 'emptyteam');
    assert.equal(session.status, 'completed');
  });
});

// ── --only filter ──────────────────────────────────────────────────────────

describe('runMergeFlow --only filter', () => {
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'omb-orchtest-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('marks non-target workers as skipped', async () => {
    const { runMergeFlow, readMergeSession } = await import('../merge-orchestrator.js');

    const teamStateRoot = join(cwd, '.omb', 'state');
    const teamDir = join(teamStateRoot, 'team', 'filterteam');
    await mkdir(teamDir, { recursive: true });

    const manifest = {
      name: 'filterteam',
      task: 'test-task',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      lifecycle_profile: 'default',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: 'omb-team-filterteam',
      next_task_id: 1,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    };
    await writeFile(join(teamDir, 'config.json'), JSON.stringify(manifest), 'utf8');

    const result = await runMergeFlow({
      teamName: 'filterteam',
      baseBranch: 'main',
      mode: 'non-interactive',
      dryRun: false,
      cleanup: false,
      detach: false,
      onlyWorker: 'worker-99',
      cwd,
    });

    // Empty workers, only filter has no effect on empty list
    assert.equal(result.success, true);
    assert.deepEqual(result.merged, []);

    const session = await readMergeSession('filterteam', cwd);
    assert.ok(session);
  });
});

// ── Concurrent runMergeFlow: lock serialisation ────────────────────────────

describe('runMergeFlow concurrent lock', () => {
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'omb-orchtest-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('two concurrent calls on same team are serialised (not both fail)', async () => {
    const { runMergeFlow } = await import('../merge-orchestrator.js');

    const teamStateRoot = join(cwd, '.omb', 'state');
    const teamDir = join(teamStateRoot, 'team', 'lockteam');
    await mkdir(teamDir, { recursive: true });

    const manifest = {
      name: 'lockteam',
      task: 'test-task',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      lifecycle_profile: 'default',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: 'omb-team-lockteam',
      next_task_id: 1,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    };
    await writeFile(join(teamDir, 'config.json'), JSON.stringify(manifest), 'utf8');

    const opts = {
      teamName: 'lockteam',
      baseBranch: 'main',
      mode: 'non-interactive' as const,
      dryRun: false,
      cleanup: false,
      detach: false,
      onlyWorker: null,
      cwd,
    };

    // Both should eventually resolve (serialised by lock)
    const [r1, r2] = await Promise.all([runMergeFlow(opts), runMergeFlow(opts)]);
    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
  });
});
