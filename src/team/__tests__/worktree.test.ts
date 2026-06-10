import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile, mkdir, rmdir } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseWorktreeMode,
  planWorktreeTarget,
  ensureWorktree,
  rollbackProvisionedWorktrees,
  sanitizePathToken,
  readWorktreeOwnerMetadata,
  WORKTREE_ERROR_CODES,
  WorktreeErrorCode,
  classifyDirectory,
  findStaleWorktreeEntries,
  pruneStaleWorktrees,
} from '../worktree.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omb-worktree-test-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('worktree parser', () => {
  it('parses detached mode from --worktree', () => {
    const parsed = parseWorktreeMode(['--worktree', '--yolo']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, ['--yolo']);
  });

  it('parses named mode from --worktree=name', () => {
    const parsed = parseWorktreeMode(['--worktree=feature/foo', 'task']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: false, name: 'feature/foo' });
    assert.deepEqual(parsed.remainingArgs, ['task']);
  });

  it('keeps args unchanged when worktree flag is absent', () => {
    const parsed = parseWorktreeMode(['team', '2:executor', 'task']);
    assert.deepEqual(parsed.mode, { enabled: false });
    assert.deepEqual(parsed.remainingArgs, ['team', '2:executor', 'task']);
  });

  it('keeps team args flag-free so the CLI can apply automatic default worktrees', () => {
    const parsed = parseWorktreeMode(['ralph', '2:executor', 'task']);
    assert.deepEqual(parsed.mode, { enabled: false });
    assert.deepEqual(parsed.remainingArgs, ['ralph', '2:executor', 'task']);
  });

  // Regression tests for issue #203: bare --worktree no longer consumes the
  // next positional arg as a branch name (space-separated syntax removed).
  it('treats bare --worktree followed by non-flag arg as detached (space-separated branch syntax removed)', () => {
    const parsed = parseWorktreeMode(['--worktree', 'my-branch']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, ['my-branch']);
  });

  it('treats bare -w followed by non-flag arg as detached (space-separated branch syntax removed)', () => {
    const parsed = parseWorktreeMode(['-w', 'my-branch']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, ['my-branch']);
  });

  it('keeps positional args after bare --worktree in remainingArgs', () => {
    const parsed = parseWorktreeMode(['--worktree', 'feat/issue-203', '--yolo']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, ['feat/issue-203', '--yolo']);
  });

  it('treats --worktree at end of args as detached', () => {
    const parsed = parseWorktreeMode(['--worktree']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, []);
  });

  it('treats -w at end of args as detached', () => {
    const parsed = parseWorktreeMode(['-w']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, []);
  });

  it('parses named branch from --worktree=feat/foo/bar', () => {
    const parsed = parseWorktreeMode(['--worktree=feat/foo/bar']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: false, name: 'feat/foo/bar' });
    assert.deepEqual(parsed.remainingArgs, []);
  });

  it('parses named branch from -wfeature/demo (combined short form)', () => {
    const parsed = parseWorktreeMode(['-wfeature/demo']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: false, name: 'feature/demo' });
    assert.deepEqual(parsed.remainingArgs, []);
  });

  it('bare --worktree does not consume task description as branch name', () => {
    const parsed = parseWorktreeMode(['--worktree', 'fix the bug', '--model', 'gpt-5']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, ['fix the bug', '--model', 'gpt-5']);
  });

  it('bare -w does not consume next positional arg', () => {
    const parsed = parseWorktreeMode(['-w', 'team', '2:executor']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, ['team', '2:executor']);
  });
});

describe('worktree planning', () => {
  it('plans dedicated autoresearch branch and path naming', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({
        cwd: repo,
        scope: 'autoresearch' as never,
        mode: { enabled: true, detached: false, name: 'demo-mission' },
        worktreeTag: '20260314T000000Z',
      });
      assert.equal(planned.enabled, true);
      if (!planned.enabled) return;

      assert.ok(planned.branchName, 'branch name should exist');
      assert.match(planned.branchName!, /^autoresearch\/demo-mission-[a-f0-9]{6}\/20260314t000000z-[a-f0-9]{6}$/);
      assert.match(planned.worktreePath.replace(/\\/g, '/'), /\.omb\/worktrees\/autoresearch-demo-mission-[a-f0-9]{6}-20260314t000000z-[a-f0-9]{6}$/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('worktree ensure + rollback', () => {
  it('creates and reuses detached worktree idempotently', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      assert.equal(planned.enabled, true);
      if (!planned.enabled) return;

      const created = ensureWorktree(planned);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;
      assert.equal(created.created, true);
      assert.equal(existsSync(created.worktreePath), true);

      const reused = ensureWorktree(planned);
      assert.equal(reused.enabled, true);
      if (!reused.enabled) return;
      assert.equal(reused.reused, true);
      assert.equal(reused.created, false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects reusing a dirty worktree', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      assert.equal(planned.enabled, true);
      if (!planned.enabled) return;

      const created = ensureWorktree(planned);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;

      await writeFile(join(created.worktreePath, 'DIRTY.txt'), 'dirty\n', 'utf-8');
      assert.throws(() => ensureWorktree(planned), /worktree_dirty/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('creates per-worker named branch and blocks branch-in-use collisions', async () => {
    const repo = await initRepo();
    try {
      const workerPlan = planWorktreeTarget({
        cwd: repo,
        scope: 'team',
        mode: { enabled: true, detached: false, name: 'feat' },
        teamName: 'alpha',
        workerName: 'worker-1',
      });
      assert.equal(workerPlan.enabled, true);
      if (!workerPlan.enabled) return;

      const created = ensureWorktree(workerPlan);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;
      assert.equal(created.created, true);
      assert.equal(created.createdBranch, true);
      assert.equal(branchExists(repo, 'feat/worker-1'), true);

      const conflictingLaunchPlan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feat/worker-1' },
      });
      assert.equal(conflictingLaunchPlan.enabled, true);
      if (!conflictingLaunchPlan.enabled) return;

      assert.throws(() => ensureWorktree(conflictingLaunchPlan), /branch_in_use/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reuses existing worktree when target path already exists as a valid alias', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/reuse-alias' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const created = ensureWorktree(plan);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;
      assert.equal(created.created, true);

      const aliasPath = `${created.worktreePath}-alias`;
      await symlink(created.worktreePath, aliasPath);

      const reused = ensureWorktree({ ...plan, worktreePath: aliasPath });
      assert.equal(reused.enabled, true);
      if (!reused.enabled) return;
      assert.equal(reused.reused, true);
      assert.equal(reused.created, false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('preserves mismatch safety when existing alias points to a different branch', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/mismatch-source' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const created = ensureWorktree(plan);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;
      assert.equal(created.created, true);

      const aliasPath = `${created.worktreePath}-alias`;
      await symlink(created.worktreePath, aliasPath);

      assert.throws(
        () => ensureWorktree({ ...plan, worktreePath: aliasPath, branchName: 'feature/other-branch' }),
        /worktree_target_mismatch/,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rollback removes newly created worktree and branch', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/rollback' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const ensured = ensureWorktree(plan);
      assert.equal(ensured.enabled, true);
      if (!ensured.enabled) return;
      assert.equal(existsSync(ensured.worktreePath), true);
      assert.equal(branchExists(repo, 'feature/rollback'), true);

      await rollbackProvisionedWorktrees([ensured]);
      assert.equal(existsSync(ensured.worktreePath), false);
      assert.equal(branchExists(repo, 'feature/rollback'), false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rollbackProvisionedWorktrees with skipBranchDeletion preserves branches', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/ralph-keep' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const ensured = ensureWorktree(plan);
      assert.equal(ensured.enabled, true);
      if (!ensured.enabled) return;
      assert.equal(existsSync(ensured.worktreePath), true);
      assert.equal(branchExists(repo, 'feature/ralph-keep'), true);

      await rollbackProvisionedWorktrees([ensured], { skipBranchDeletion: true });
      assert.equal(existsSync(ensured.worktreePath), false);
      // Branch is preserved when skipBranchDeletion is true (ralph policy)
      assert.equal(branchExists(repo, 'feature/ralph-keep'), true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('sanitizePathToken collision resistance', () => {
  it('produces different tokens for inputs that normalize identically', () => {
    const t1 = sanitizePathToken('Feature-X');
    const t2 = sanitizePathToken('feature_x');
    const t3 = sanitizePathToken('feature/x');
    // All normalize to "feature-x" but hashes differ
    assert.notEqual(t1, t2);
    assert.notEqual(t2, t3);
    assert.notEqual(t1, t3);
  });

  it('produces same token for identical input', () => {
    assert.equal(sanitizePathToken('my-feature'), sanitizePathToken('my-feature'));
  });

  it('handles empty and special-char input', () => {
    const token = sanitizePathToken('---');
    assert.ok(token.startsWith('default-'));
  });

  it('preserves hash suffix length', () => {
    const token = sanitizePathToken('test');
    const parts = token.split('-');
    // Last part should be 6-char hash
    assert.equal(parts[parts.length - 1].length, 6);
  });
});

describe('worktree owner metadata', () => {
  it('writes and reads owner metadata on worktree creation', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'team',
        mode: { enabled: true, detached: false, name: 'feat' },
        teamName: 'alpha',
        workerName: 'worker-1',
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const created = ensureWorktree(plan);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;

      const meta = readWorktreeOwnerMetadata(created.worktreePath);
      assert.ok(meta);
      assert.equal(meta!.team_name, 'alpha');
      assert.equal(meta!.worker_name, 'worker-1');
      assert.equal(meta!.repo_root, repo);
      assert.equal(meta!.mode, 'named');
      assert.ok(meta!.branch_name);
      assert.ok(meta!.created_at);
      assert.ok(meta!.omb_version);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects reuse when owner metadata team/worker mismatch', async () => {
    const repo = await initRepo();
    try {
      // Create worktree with team alpha / worker-1
      const plan1 = planWorktreeTarget({
        cwd: repo,
        scope: 'team',
        mode: { enabled: true, detached: false, name: 'feat' },
        teamName: 'alpha',
        workerName: 'worker-1',
      });
      assert.equal(plan1.enabled, true);
      if (!plan1.enabled) return;

      const created = ensureWorktree(plan1);
      assert.equal(created.enabled, true);

      // Try to reuse with different team/worker — same worktree path won't match
      // because sanitizePathToken now includes hash, so different teamName/workerName
      // produce different paths. Test owner mismatch by directly calling ensureWorktree
      // with a modified plan that has the same path but different team/worker.
      const mismatchedPlan = {
        ...plan1,
        teamName: 'beta',
        workerName: 'worker-2',
      };

      assert.throws(
        () => ensureWorktree(mismatchedPlan),
        /worktree_owner_mismatch/,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('allows reuse when no owner metadata exists (backward compat)', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const created = ensureWorktree(plan);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;

      // Remove owner metadata file to simulate pre-existing worktree
      const { unlinkSync } = await import('node:fs');
      const ownerPath = join(created.worktreePath, '.omb-worktree-owner.json');
      if (existsSync(ownerPath)) {
        unlinkSync(ownerPath);
      }

      // Reuse should still work without owner metadata
      const reused = ensureWorktree(plan);
      assert.equal(reused.enabled, true);
      if (!reused.enabled) return;
      assert.equal(reused.reused, true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('WORKTREE_ERROR_CODES', () => {
  it('has all expected error codes', () => {
    assert.ok('WORKTREE_DIRTY' in WORKTREE_ERROR_CODES);
    assert.ok('WORKTREE_OWNER_MISMATCH' in WORKTREE_ERROR_CODES);
    assert.ok('WORKTREE_NOT_GIT' in WORKTREE_ERROR_CODES);
    assert.ok('WORKTREE_STALE_ENTRY' in WORKTREE_ERROR_CODES);
    assert.ok('WORKTREE_BRANCH_IN_USE' in WORKTREE_ERROR_CODES);
    assert.ok('WORKTREE_PATH_CONFLICT' in WORKTREE_ERROR_CODES);
    assert.ok('WORKTREE_TARGET_MISMATCH' in WORKTREE_ERROR_CODES);
  });

  it('error codes are string constants', () => {
    const codes: WorktreeErrorCode[] = Object.values(WORKTREE_ERROR_CODES);
    for (const code of codes) {
      assert.equal(typeof code, 'string');
      assert.ok(code.length > 0);
    }
  });
});

describe('classifyDirectory', () => {
  it('classifies non-existent directory', () => {
    assert.equal(classifyDirectory('/nonexistent/path/xyz-omb-test'), 'does_not_exist');
  });

  it('classifies empty directory as non_git_directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-classify-empty-'));
    try {
      assert.equal(classifyDirectory(dir), 'non_git_directory');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('classifies a git repo (not worktree) as git_repo', async () => {
    const repo = await initRepo();
    try {
      assert.equal(classifyDirectory(repo), 'git_repo');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('classifies a git worktree as git_worktree', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      if (!planned.enabled) return;
      const created = ensureWorktree(planned);
      if (!created.enabled) return;
      assert.equal(classifyDirectory(created.worktreePath), 'git_worktree');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('classifies a file path as non_git_directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-classify-file-'));
    try {
      const filePath = join(dir, 'somefile.txt');
      writeFileSync(filePath, 'hello', 'utf8');
      assert.equal(classifyDirectory(filePath), 'non_git_directory');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('structured error messages', () => {
  it('worktree_dirty error includes cleanup suggestion', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      if (!planned.enabled) return;
      const created = ensureWorktree(planned);
      if (!created.enabled) return;

      await writeFile(join(created.worktreePath, 'DIRTY.txt'), 'dirty\n', 'utf-8');
      assert.throws(
        () => ensureWorktree(planned),
        (err: unknown) => {
          const msg = (err as Error).message;
          return msg.startsWith('worktree_dirty:') && msg.includes('omb doctor --worktrees');
        },
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('worktree_owner_mismatch error includes cleanup suggestion', async () => {
    const repo = await initRepo();
    try {
      const plan1 = planWorktreeTarget({
        cwd: repo,
        scope: 'team',
        mode: { enabled: true, detached: false, name: 'feat' },
        teamName: 'alpha',
        workerName: 'worker-1',
      });
      if (!plan1.enabled) return;
      ensureWorktree(plan1);

      const mismatchedPlan = { ...plan1, teamName: 'beta', workerName: 'worker-2' };
      assert.throws(
        () => ensureWorktree(mismatchedPlan),
        (err: unknown) => {
          const msg = (err as Error).message;
          return msg.startsWith('worktree_owner_mismatch:') && msg.includes('omb doctor --worktrees');
        },
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('worktree_branch_in_use error includes cleanup suggestion', async () => {
    const repo = await initRepo();
    try {
      const workerPlan = planWorktreeTarget({
        cwd: repo,
        scope: 'team',
        mode: { enabled: true, detached: false, name: 'feat' },
        teamName: 'alpha',
        workerName: 'worker-1',
      });
      if (!workerPlan.enabled) return;
      ensureWorktree(workerPlan);

      const conflictingLaunchPlan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feat/worker-1' },
      });
      if (!conflictingLaunchPlan.enabled) return;
      assert.throws(
        () => ensureWorktree(conflictingLaunchPlan),
        (err: unknown) => {
          const msg = (err as Error).message;
          return msg.startsWith('worktree_branch_in_use:') && msg.includes('omb doctor --worktrees');
        },
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('worktree_target_mismatch error includes cleanup suggestion', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/mismatch-source' },
      });
      if (!plan.enabled) return;
      const created = ensureWorktree(plan);
      if (!created.enabled) return;

      const aliasPath = `${created.worktreePath}-alias`;
      await symlink(created.worktreePath, aliasPath);

      assert.throws(
        () => ensureWorktree({ ...plan, worktreePath: aliasPath, branchName: 'feature/other-branch' }),
        (err: unknown) => {
          const msg = (err as Error).message;
          return msg.startsWith('worktree_target_mismatch:') && msg.includes('omb doctor --worktrees');
        },
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('worktree_not_git error for non-git directory at worktree path', async () => {
    const repo = await initRepo();
    try {
      // Create a plan, then modify its worktreePath to point at a pre-created non-git directory
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'team',
        mode: { enabled: true, detached: false, name: 'feat' },
        teamName: 'alpha',
        workerName: 'worker-1',
      });
      if (!plan.enabled) return;

      // Create an isolated temp directory that is NOT inside the repo and has no .git
      const isolatedDir = await mkdtemp(join(tmpdir(), 'omb-not-git-'));
      writeFileSync(join(isolatedDir, 'random.txt'), 'not a git repo', 'utf8');

      // Override the worktreePath to point at this non-git directory
      const modifiedPlan = { ...plan, worktreePath: isolatedDir };

      assert.throws(
        () => ensureWorktree(modifiedPlan),
        (err: unknown) => {
          const msg = (err as Error).message;
          return msg.startsWith('worktree_not_git:') && msg.includes('non_git_directory') && msg.includes('omb doctor --worktrees');
        },
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('findStaleWorktreeEntries', () => {
  it('returns empty array when no stale entries exist', async () => {
    const repo = await initRepo();
    try {
      const stale = findStaleWorktreeEntries(repo);
      assert.deepEqual(stale, []);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('detects stale worktree entry after directory removal', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      if (!plan.enabled) return;
      const created = ensureWorktree(plan);
      if (!created.enabled) return;

      // Force-remove the worktree directory without git knowing
      await rm(created.worktreePath, { recursive: true, force: true });

      const stale = findStaleWorktreeEntries(repo);
      assert.ok(stale.length > 0, 'should find at least one stale entry');
      assert.ok(stale.some(e => e.path === created.worktreePath || e.path === resolve(created.worktreePath)));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('pruneStaleWorktrees removes stale entries and returns them', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      if (!plan.enabled) return;
      const created = ensureWorktree(plan);
      if (!created.enabled) return;

      await rm(created.worktreePath, { recursive: true, force: true });

      const pruned = pruneStaleWorktrees(repo);
      assert.ok(pruned.length > 0, 'should report pruned entries');

      // After prune, no more stale entries
      const stale = findStaleWorktreeEntries(repo);
      assert.equal(stale.length, 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
