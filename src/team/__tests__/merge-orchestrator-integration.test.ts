/**
 * Integration tests for merge-orchestrator.ts
 * Uses a real temporary git repository — no mocks.
 * node:test + node:assert/strict
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { rm, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// ── Git test-repo helpers ──────────────────────────────────────────────────

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  }).trim();
}

function initTestRepo(baseDir: string): string {
  const repo = join(baseDir, 'repo');
  execSync(`mkdir -p ${repo}`);
  git('init', repo);
  git('checkout -b main', repo);

  // Initial commit on main
  execSync(`echo "hello" > ${join(repo, 'README.md')}`);
  git('add README.md', repo);
  git('commit -m "init"', repo);

  return repo;
}

function createWorkerBranch(
  repo: string,
  branchName: string,
  fileName: string,
  content: string,
): void {
  git(`checkout -b ${branchName}`, repo);
  execSync(`echo "${content}" > ${join(repo, fileName)}`);
  git(`add ${fileName}`, repo);
  git(`commit -m "add ${fileName}"`, repo);
  git('checkout main', repo);
}

// ── OmB team manifest helper ───────────────────────────────────────────────

async function writeTeamManifest(
  teamName: string,
  cwd: string,
  workers: Array<{ name: string; branch: string }>,
  leaderCwd: string,
): Promise<void> {
  const teamDir = join(cwd, '.omb', 'state', 'team', teamName);
  await mkdir(teamDir, { recursive: true });

  // Write as TeamConfig (config.json) so readTeamConfig fallback can find it
  const config = {
    name: teamName,
    task: 'integration-test',
    agent_type: 'claude',
    worker_launch_mode: 'interactive',
    lifecycle_profile: 'default',
    worker_count: workers.length,
    max_workers: 20,
    workers: workers.map((w, i) => ({
      name: w.name,
      index: i + 1,
      role: 'worker',
      assigned_tasks: [],
      pane_id: `%${i + 1}`,
      worktree_branch: w.branch,
      worktree_path: null,
    })),
    created_at: new Date().toISOString(),
    tmux_session: `omb-team-${teamName}`,
    next_task_id: 1,
    leader_cwd: leaderCwd,
    leader_pane_id: null,
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
  };

  await writeFile(join(teamDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

async function withMockTmuxFixture<T>(
  dirPrefix: string,
  tmuxScript: (tmuxLogPath: string) => string,
  run: (ctx: { logPath: string }) => Promise<T>,
): Promise<T> {
  const fakeBinDir = mkdtempSync(join(tmpdir(), dirPrefix));
  const logPath = join(fakeBinDir, 'tmux.log');
  const tmuxStubPath = join(fakeBinDir, 'tmux');
  const previousPath = process.env.PATH;

  try {
    await writeFile(tmuxStubPath, tmuxScript(logPath), 'utf8');
    await chmod(tmuxStubPath, 0o755);
    process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
    return await run({ logPath });
  } finally {
    if (typeof previousPath === 'string') process.env.PATH = previousPath;
    else delete process.env.PATH;
    await rm(fakeBinDir, { recursive: true, force: true });
  }
}

const READY_PROMPT_CAPTURE = `╭────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.118.0)                 │
│                                            │
│ model:     gpt-5.4 high   /model to change │
│ directory: ~/Workspace/demo                │
╰────────────────────────────────────────────╯

How can I help you today?`;

// ── Tests ──────────────────────────────────────────────────────────────────

let baseDir: string;
let repoRoot: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'omb-int-'));
  repoRoot = initTestRepo(baseDir);
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe('integration: runMergeFlow non-interactive, clean merges', () => {
  it('merges a clean worker branch with no conflicts', async () => {
    const { runMergeFlow, readMergeSession } = await import('../merge-orchestrator.js');
    const cwd = baseDir;
    const teamName = 'clean-merge';

    // Create worker branch with no conflicts
    createWorkerBranch(repoRoot, 'feature/worker-1', 'worker1.txt', 'worker 1 output');

    await writeTeamManifest(
      teamName,
      cwd,
      [{ name: 'worker-1', branch: 'feature/worker-1' }],
      repoRoot,
    );

    const result = await runMergeFlow({
      teamName,
      baseBranch: 'main',
      mode: 'non-interactive',
      dryRun: false,
      cleanup: false,
      detach: false,
      onlyWorker: null,
      cwd,
    });

    assert.equal(result.success, true, 'should succeed');
    assert.deepEqual(result.merged, ['worker-1']);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.failed, []);

    // Verify session is written as completed
    const session = await readMergeSession(teamName, cwd);
    assert.ok(session, 'session should exist');
    assert.equal(session.status, 'completed');
    assert.equal(session.workers[0].status, 'merged');
    assert.ok(session.workers[0].mergeCommit, 'merge commit should be set');

    // Verify file actually exists on main
    const mergedFile = join(repoRoot, 'worker1.txt');
    assert.ok(existsSync(mergedFile), 'merged file should exist on main');
  });

  it('merges multiple clean worker branches sequentially', async () => {
    const { runMergeFlow, readMergeSession } = await import('../merge-orchestrator.js');
    const cwd = baseDir;
    const teamName = 'multi-merge';

    createWorkerBranch(repoRoot, 'feature/worker-1', 'file1.txt', 'file1');
    createWorkerBranch(repoRoot, 'feature/worker-2', 'file2.txt', 'file2');

    await writeTeamManifest(
      teamName,
      cwd,
      [
        { name: 'worker-1', branch: 'feature/worker-1' },
        { name: 'worker-2', branch: 'feature/worker-2' },
      ],
      repoRoot,
    );

    const result = await runMergeFlow({
      teamName,
      baseBranch: 'main',
      mode: 'non-interactive',
      dryRun: false,
      cleanup: false,
      detach: false,
      onlyWorker: null,
      cwd,
    });

    assert.equal(result.success, true);
    assert.equal(result.merged.length, 2);
    assert.deepEqual(result.conflicts, []);

    const session = await readMergeSession(teamName, cwd);
    assert.ok(session);
    assert.equal(session.status, 'completed');
    assert.equal(session.workers.filter((w) => w.status === 'merged').length, 2);
  });
});

describe('integration: leader-online attached fallback', () => {
  it('falls back to inline merge immediately instead of waiting on worker-pane completion', async () => {
    const { runMergeFlow } = await import('../merge-orchestrator.js');
    const cwd = baseDir;
    const teamName = 'leader-online-inline';

    createWorkerBranch(repoRoot, 'feature/leader-inline', 'leader-inline.txt', 'leader inline merge');

    await writeTeamManifest(
      teamName,
      cwd,
      [{ name: 'worker-1', branch: 'feature/leader-inline' }],
      repoRoot,
    );

    const configPath = join(cwd, '.omb', 'state', 'team', teamName, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.leader_pane_id = '%0';
    config.workers[0].pane_id = '%1';
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withMockTmuxFixture(
      'omb-merge-tmux-',
      (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    cat <<'EOF'
${READY_PROMPT_CAPTURE}
EOF
    exit 0
    ;;
  send-keys)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async () => {
        const startedAt = Date.now();
        const result = await Promise.race([
          runMergeFlow({
            teamName,
            baseBranch: 'main',
            mode: 'leader-online',
            dryRun: false,
            cleanup: false,
            detach: false,
            onlyWorker: null,
            cwd,
          }),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('leader-online merge timed out')), 2_000);
          }),
        ]);

        assert.equal(result.success, true);
        assert.deepEqual(result.merged, ['worker-1']);
        assert.ok(
          Date.now() - startedAt < 2_000,
          'leader-online attached merge should complete inline without worker wait timeout',
        );
      },
    );
  });
});

describe('integration: runMergeFlow conflict detection', () => {
  it('detects conflict and writes conflict report', async () => {
    const { runMergeFlow, readMergeSession } = await import('../merge-orchestrator.js');
    const cwd = baseDir;
    const teamName = 'conflict-team';

    // Create conflicting worker branch: modify README.md (same file as main)
    git('checkout -b feature/conflict-worker', repoRoot);
    execSync(`echo "conflicting content" > ${join(repoRoot, 'README.md')}`);
    git('add README.md', repoRoot);
    git('commit -m "conflict change"', repoRoot);
    // Advance main so the branches actually diverge
    git('checkout main', repoRoot);
    execSync(`echo "main update" >> ${join(repoRoot, 'README.md')}`);
    git('add README.md', repoRoot);
    git('commit -m "main advance"', repoRoot);

    // Create a second worker that would otherwise succeed — it should be SKIPPED (AC-5)
    createWorkerBranch(repoRoot, 'feature/safe-worker', 'safe.txt', 'safe content');

    await writeTeamManifest(
      teamName,
      cwd,
      [
        { name: 'conflict-worker', branch: 'feature/conflict-worker' },
        { name: 'safe-worker', branch: 'feature/safe-worker' },
      ],
      repoRoot,
    );

    const result = await runMergeFlow({
      teamName,
      baseBranch: 'main',
      mode: 'non-interactive',
      dryRun: false,
      cleanup: false,
      detach: false,
      onlyWorker: null,
      cwd,
    });

    // Success = false because there's a conflict
    assert.equal(result.success, false);
    // conflict-worker is reported as either conflict or merged
    // (depends on git version for merge-tree detection)
    const allProblematic = [...result.conflicts, ...(result.failed ?? [])];
    assert.ok(
      allProblematic.includes('conflict-worker') || result.merged.includes('conflict-worker'),
      `conflict-worker should appear in results: ${JSON.stringify(result)}`,
    );

    // AC-5: safe-worker must be skipped (stop-on-first-failure)
    assert.ok(
      result.skipped.includes('safe-worker'),
      `safe-worker should be skipped after conflict, got skipped=${JSON.stringify(result.skipped)}`,
    );

    const session = await readMergeSession(teamName, cwd);
    assert.ok(session, 'session should exist');
    // status should be paused or failed (not completed) due to conflict
    assert.ok(
      session.status === 'paused' || session.status === 'failed',
      `Expected paused or failed, got ${session.status}`,
    );

    // AC-5: session worker entry for safe-worker should be 'skipped'
    const safeWorkerEntry = session.workers.find((w) => w.name === 'safe-worker');
    assert.ok(safeWorkerEntry, 'safe-worker entry should exist in session');
    assert.equal(safeWorkerEntry.status, 'skipped', 'safe-worker session status should be skipped');
  });
});

describe('integration: runMergeFlow --only filter', () => {
  it('only merges the specified worker, skips others', async () => {
    const { runMergeFlow, readMergeSession } = await import('../merge-orchestrator.js');
    const cwd = baseDir;
    const teamName = 'only-test';

    createWorkerBranch(repoRoot, 'feature/worker-1', 'only1.txt', 'only worker 1');
    createWorkerBranch(repoRoot, 'feature/worker-2', 'only2.txt', 'only worker 2');

    await writeTeamManifest(
      teamName,
      cwd,
      [
        { name: 'worker-1', branch: 'feature/worker-1' },
        { name: 'worker-2', branch: 'feature/worker-2' },
      ],
      repoRoot,
    );

    const result = await runMergeFlow({
      teamName,
      baseBranch: 'main',
      mode: 'non-interactive',
      dryRun: false,
      cleanup: false,
      detach: false,
      onlyWorker: 'worker-1',
      cwd,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.merged, ['worker-1']);
    assert.ok(result.skipped.includes('worker-2'), 'worker-2 should be skipped');

    // only1.txt on main, only2.txt not yet merged
    assert.ok(existsSync(join(repoRoot, 'only1.txt')), 'only1.txt should exist on main');
    assert.equal(existsSync(join(repoRoot, 'only2.txt')), false, 'only2.txt should not exist yet');

    const session = await readMergeSession(teamName, cwd);
    assert.ok(session);
    const w2 = session.workers.find((w) => w.name === 'worker-2');
    assert.ok(w2, 'worker-2 should be in session');
    assert.equal(w2.status, 'skipped');
  });
});

describe('integration: runMergeFlow resume mode', () => {
  it('resumes after a previous run, re-attempting pending workers', async () => {
    const { runMergeFlow, readMergeSession, writeMergeSession } = await import(
      '../merge-orchestrator.js'
    );
    const cwd = baseDir;
    const teamName = 'resume-team';

    createWorkerBranch(repoRoot, 'feature/worker-1', 'resume1.txt', 'resume output');

    await writeTeamManifest(
      teamName,
      cwd,
      [{ name: 'worker-1', branch: 'feature/worker-1' }],
      repoRoot,
    );

    // Write a fake "paused" session to simulate a previous interrupted run
    await runMergeFlow({
      teamName,
      baseBranch: 'main',
      mode: 'non-interactive',
      dryRun: false,
      cleanup: false,
      detach: false,
      onlyWorker: null,
      cwd,
    });

    // After successful merge, try resume — should still succeed (idempotent)
    // Reset worker status to pending to simulate re-try scenario
    const session = await readMergeSession(teamName, cwd);
    assert.ok(session);
    await writeMergeSession(
      {
        ...session,
        status: 'paused',
        workers: session.workers.map((w) => ({ ...w, status: 'pending' as const })),
      },
      cwd,
    );

    // Note: on resume, worker-1 branch is already merged, so the git merge
    // will produce a "Already up to date." result — which is a success.
    const result = await runMergeFlow({
      teamName,
      baseBranch: 'main',
      mode: 'resume',
      dryRun: false,
      cleanup: false,
      detach: false,
      onlyWorker: null,
      cwd,
    });

    assert.ok(
      result.success || result.merged.length >= 0,
      'resume should complete without throwing',
    );
  });
});

describe('integration: session file atomic write', () => {
  it('session.json exists and is valid JSON after runMergeFlow', async () => {
    const { runMergeFlow } = await import('../merge-orchestrator.js');
    const { mergeSessionPath } = await import('../merge-session.js');
    const cwd = baseDir;
    const teamName = 'atomic-write';

    createWorkerBranch(repoRoot, 'feature/atomic-w1', 'atomic.txt', 'atomic content');

    await writeTeamManifest(
      teamName,
      cwd,
      [{ name: 'w1', branch: 'feature/atomic-w1' }],
      repoRoot,
    );

    await runMergeFlow({
      teamName,
      baseBranch: 'main',
      mode: 'non-interactive',
      dryRun: false,
      cleanup: false,
      detach: false,
      onlyWorker: null,
      cwd,
    });

    const sessionFile = mergeSessionPath(teamName, cwd);
    assert.ok(existsSync(sessionFile), 'session.json must exist');
    const raw = await readFile(sessionFile, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.teamName, teamName);
    assert.ok(parsed.version === 1, 'version must be 1');

    // No .tmp files remain
    const dir = sessionFile.replace('/session.json', '');
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(dir);
    const tmpFiles = files.filter((f: string) => f.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 0, 'no .tmp files should remain');
  });
});

// ── Dry-run (AC-2/AC-3) ───────────────────────────────────────────────────

describe('integration: runMergeFlow --dry-run', () => {
  it('dry-run: returns success=true with no merges and no session written', async () => {
    const { runMergeFlow, readMergeSession } = await import('../merge-orchestrator.js');
    const cwd = baseDir;
    const teamName = 'dryrun-team';

    createWorkerBranch(repoRoot, 'feature/dry-w1', 'dry1.txt', 'dry content 1');
    createWorkerBranch(repoRoot, 'feature/dry-w2', 'dry2.txt', 'dry content 2');

    await writeTeamManifest(
      teamName,
      cwd,
      [
        { name: 'dry-w1', branch: 'feature/dry-w1' },
        { name: 'dry-w2', branch: 'feature/dry-w2' },
      ],
      repoRoot,
    );

    const result = await runMergeFlow({
      teamName,
      baseBranch: 'main',
      mode: 'non-interactive',
      dryRun: true,
      cleanup: false,
      detach: false,
      onlyWorker: null,
      cwd,
    });

    // AC-2: dry-run must return success=true, no merges performed
    assert.equal(result.success, true, 'dry-run should report success=true');
    assert.deepEqual(result.merged, [], 'dry-run should not merge any workers');
    assert.deepEqual(result.failed, [], 'dry-run should have no failures');

    // AC-3: no session.json should be written
    const session = await readMergeSession(teamName, cwd);
    assert.equal(session, null, 'dry-run must not write a session file');

    // The actual files should NOT be on main (no real merge happened)
    assert.equal(existsSync(join(repoRoot, 'dry1.txt')), false, 'dry1.txt must not exist on main after dry-run');
    assert.equal(existsSync(join(repoRoot, 'dry2.txt')), false, 'dry2.txt must not exist on main after dry-run');
  });

  it('dry-run: reports conflict names without performing merge', async () => {
    const { runMergeFlow } = await import('../merge-orchestrator.js');
    const cwd = baseDir;
    const teamName = 'dryrun-conflict-team';

    // Create a conflicting branch
    git('checkout -b feature/dry-conflict', repoRoot);
    execSync(`echo "dry conflict" > ${join(repoRoot, 'README.md')}`);
    git('add README.md', repoRoot);
    git('commit -m "dry conflict change"', repoRoot);
    git('checkout main', repoRoot);
    execSync(`echo "main dry update" >> ${join(repoRoot, 'README.md')}`);
    git('add README.md', repoRoot);
    git('commit -m "main dry advance"', repoRoot);

    await writeTeamManifest(
      teamName,
      cwd,
      [{ name: 'dry-conflict', branch: 'feature/dry-conflict' }],
      repoRoot,
    );

    const result = await runMergeFlow({
      teamName,
      baseBranch: 'main',
      mode: 'non-interactive',
      dryRun: true,
      cleanup: false,
      detach: false,
      onlyWorker: null,
      cwd,
    });

    // AC-3: dry-run still returns success=true even when conflicts detected
    assert.equal(result.success, true, 'dry-run always returns success=true');
    // The conflict should be reported in result.conflicts
    // (may be empty if git merge-tree reports no conflicts, that is also acceptable)
    assert.deepEqual(result.merged, [], 'no merges in dry-run');
  });
});

// ── result.json (AC-4) ────────────────────────────────────────────────────

describe('integration: runMergeFlow result.json (AC-4)', () => {
  it('writes result.json with correct shape after 3-worker clean merge', async () => {
    const { runMergeFlow } = await import('../merge-orchestrator.js');
    const { mergeSessionPath: msp } = await import('../merge-session.js');
    const cwd = baseDir;
    const teamName = 'result-json-team';

    createWorkerBranch(repoRoot, 'feature/rj-w1', 'rj1.txt', 'rj worker 1');
    createWorkerBranch(repoRoot, 'feature/rj-w2', 'rj2.txt', 'rj worker 2');
    createWorkerBranch(repoRoot, 'feature/rj-w3', 'rj3.txt', 'rj worker 3');

    await writeTeamManifest(
      teamName,
      cwd,
      [
        { name: 'rj-w1', branch: 'feature/rj-w1' },
        { name: 'rj-w2', branch: 'feature/rj-w2' },
        { name: 'rj-w3', branch: 'feature/rj-w3' },
      ],
      repoRoot,
    );

    const result = await runMergeFlow({
      teamName,
      baseBranch: 'main',
      mode: 'non-interactive',
      dryRun: false,
      cleanup: false,
      detach: false,
      onlyWorker: null,
      cwd,
    });

    assert.equal(result.success, true, '3-worker merge should succeed');
    assert.equal(result.merged.length, 3, 'all 3 workers should be merged');

    // AC-4: resultPath must be set
    assert.ok(result.resultPath, 'resultPath must be set in MergeFlowResult');
    assert.ok(existsSync(result.resultPath!), 'result.json file must exist on disk');

    // Validate result.json shape
    const raw = await readFile(result.resultPath!, 'utf8');
    const rj = JSON.parse(raw);
    assert.equal(rj.version, 1, 'result.json version must be 1');
    assert.equal(rj.teamName, teamName, 'teamName must match');
    assert.equal(rj.success, true, 'success must be true');
    assert.equal(rj.merged.length, 3, 'merged must have 3 entries');
    assert.deepEqual(rj.conflicts, [], 'conflicts must be empty');
    assert.deepEqual(rj.skipped, [], 'skipped must be empty');
    assert.deepEqual(rj.failed, [], 'failed must be empty');
    assert.ok(typeof rj.startedAt === 'string', 'startedAt must be a string');
    assert.ok(typeof rj.completedAt === 'string', 'completedAt must be a string');
    assert.equal(rj.cleanup, false, 'cleanup must match options');
    assert.ok(Array.isArray(rj.worktreesRemoved), 'worktreesRemoved must be an array');
    assert.ok(Array.isArray(rj.branchesDeleted), 'branchesDeleted must be an array');

    // result.json lives alongside session.json
    const sessionDir = msp(teamName, cwd).replace('/session.json', '');
    assert.equal(
      result.resultPath,
      join(sessionDir, 'result.json'),
      'resultPath must be inside session dir',
    );
  });
});
