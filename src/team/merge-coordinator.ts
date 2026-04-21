/**
 * Merge Coordinator - Handles merging worker branches back to the main branch
 *
 * Provides conflict detection (dry-run) and actual merge execution for
 * team worktrees. Uses git merge-tree for non-destructive conflict
 * simulation (Git 2.38+), with a file-overlap heuristic fallback for
 * older Git versions.
 *
 */

import { execSync } from "child_process";

// ── Types ──────────────────────────────────────────────────────────────

export interface MergeResult {
  workerName: string;
  branch: string;
  success: boolean;
  conflicts: string[];
  mergeCommit?: string;
}

export interface ConflictCheckResult {
  hasConflicts: boolean;
  conflictingFiles: string[];
  method: "merge-tree" | "file-overlap" | "unknown";
}

// ── Validation ─────────────────────────────────────────────────────────

/** Validate branch name to prevent flag injection. */
const BRANCH_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;

function validateBranchName(branch: string): void {
  if (!BRANCH_NAME_PATTERN.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}

// ── Git helpers ────────────────────────────────────────────────────────

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gitSafe(args: string, cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** Check if the git version supports merge-tree --write-tree (2.38+). */
function hasModernMergeTree(repoRoot: string): boolean {
  const version = gitSafe("--version", repoRoot);
  if (!version) return false;
  const match = version.match(/git version (\d+)\.(\d+)/);
  if (!match) return false;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  return major > 2 || (major === 2 && minor >= 38);
}

// ── Conflict detection ─────────────────────────────────────────────────

/**
 * Non-destructive conflict check using git merge-tree (Git 2.38+).
 * Simulates a merge without touching the working tree.
 * Falls back to file-overlap heuristic for older Git.
 */
export function checkMergeConflicts(
  workerBranch: string,
  baseBranch: string,
  repoRoot: string,
): ConflictCheckResult {
  validateBranchName(workerBranch);
  validateBranchName(baseBranch);

  // Modern path: git merge-tree --write-tree
  if (hasModernMergeTree(repoRoot)) {
    try {
      const result = git(
        `merge-tree --write-tree ${baseBranch} ${workerBranch}`,
        repoRoot,
      );
      // Exit code 0 = clean merge, output is the tree hash
      // Exit code 1 = conflicts, output contains CONFLICT lines
      const conflicts: string[] = [];
      for (const line of result.split("\n")) {
        const match = line.match(/CONFLICT.*:\s+(.+)/);
        if (match) {
          // Extract file path from conflict line
          const fileMatch = match[1].match(/in\s+(\S+)/);
          if (fileMatch) conflicts.push(fileMatch[1]);
        }
      }
      return {
        hasConflicts: conflicts.length > 0,
        conflictingFiles: conflicts,
        method: "merge-tree",
      };
    } catch (error) {
      // merge-tree with conflicts returns exit code 1
      const output =
        error instanceof Error && "stdout" in error
          ? String((error as { stdout: Buffer }).stdout)
          : "";
      const conflicts: string[] = [];
      for (const line of output.split("\n")) {
        const match = line.match(/CONFLICT.*:\s+(.+)/);
        if (match) {
          const fileMatch = match[1].match(/in\s+(\S+)/);
          if (fileMatch) conflicts.push(fileMatch[1]);
        }
      }
      if (conflicts.length > 0) {
        return {
          hasConflicts: true,
          conflictingFiles: conflicts,
          method: "merge-tree",
        };
      }
    }
  }

  // Fallback: file-overlap heuristic
  try {
    const mergeBase = git(`merge-base ${baseBranch} ${workerBranch}`, repoRoot);
    const baseChanges = git(`diff --name-only ${mergeBase} ${baseBranch}`, repoRoot);
    const workerChanges = git(
      `diff --name-only ${mergeBase} ${workerBranch}`,
      repoRoot,
    );

    const baseFiles = new Set(baseChanges.split("\n").filter(Boolean));
    const workerFiles = new Set(workerChanges.split("\n").filter(Boolean));

    const overlap: string[] = [];
    for (const file of workerFiles) {
      if (baseFiles.has(file)) overlap.push(file);
    }

    return {
      hasConflicts: overlap.length > 0,
      conflictingFiles: overlap,
      method: "file-overlap",
    };
  } catch {
    return {
      hasConflicts: false,
      conflictingFiles: [],
      method: "unknown",
    };
  }
}

// ── Merge execution ────────────────────────────────────────────────────

/**
 * Merge a worker branch into the base branch.
 * Always aborts on failure, leaving the repo in a clean state.
 */
export function mergeWorkerBranch(
  workerBranch: string,
  baseBranch: string,
  repoRoot: string,
): MergeResult {
  validateBranchName(workerBranch);
  validateBranchName(baseBranch);

  // Check for uncommitted changes
  try {
    git("diff-index --quiet HEAD", repoRoot);
  } catch {
    return {
      workerName: "",
      branch: workerBranch,
      success: false,
      conflicts: ["uncommitted changes in working tree"],
    };
  }

  // Checkout base branch
  try {
    git(`checkout ${baseBranch}`, repoRoot);
  } catch {
    return {
      workerName: "",
      branch: workerBranch,
      success: false,
      conflicts: [`failed to checkout ${baseBranch}`],
    };
  }

  // Attempt merge
  try {
    git(`merge --no-ff ${workerBranch} -m "Merge ${workerBranch} into ${baseBranch}"`, repoRoot);
    const mergeCommit = git("rev-parse HEAD", repoRoot);
    return {
      workerName: "",
      branch: workerBranch,
      success: true,
      conflicts: [],
      mergeCommit,
    };
  } catch (error) {
    // Always abort on failure
    gitSafe("merge --abort", repoRoot);

    const output =
      error instanceof Error && "stdout" in error
        ? String((error as { stdout: Buffer }).stdout)
        : String(error);
    const conflicts: string[] = [];
    for (const line of output.split("\n")) {
      const match = line.match(/CONFLICT.*:\s+(.+)/);
      if (match) {
        const fileMatch = match[1].match(/in\s+(\S+)/);
        if (fileMatch) conflicts.push(fileMatch[1]);
      }
    }

    return {
      workerName: "",
      branch: workerBranch,
      success: false,
      conflicts: conflicts.length > 0 ? conflicts : ["merge failed"],
    };
  }
}

/**
 * Merge all worker branches for a team sequentially.
 * Stops on first failure to prevent cascading issues.
 */
export function mergeAllWorkerBranches(
  workerBranches: Array<{ workerName: string; branch: string }>,
  repoRoot: string,
  baseBranch: string = "main",
): MergeResult[] {
  validateBranchName(baseBranch);
  const results: MergeResult[] = [];

  for (const { workerName, branch } of workerBranches) {
    const result = mergeWorkerBranch(branch, baseBranch, repoRoot);
    result.workerName = workerName;
    results.push(result);

    if (!result.success) {
      // Stop on first failure
      break;
    }
  }

  return results;
}
