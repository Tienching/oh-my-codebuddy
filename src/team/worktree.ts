import { execFile as execFileCb, execFileSync, spawnSync } from 'child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import {
  assertCurrentTaskBranchAvailable,
  upsertCurrentTaskBaseline,
} from './current-task-baseline.js';

const execFilePromise = promisify(execFileCb);

export type WorktreeMode =
  | { enabled: false }
  | { enabled: true; detached: true; name: null }
  | { enabled: true; detached: false; name: string };

export interface ParsedWorktreeMode {
  mode: WorktreeMode;
  remainingArgs: string[];
}

export interface WorktreePlanInput {
  cwd: string;
  scope: 'launch' | 'team' | 'autoresearch';
  mode: WorktreeMode;
  teamName?: string;
  workerName?: string;
  worktreeTag?: string;
}

export interface PlannedWorktreeTarget {
  enabled: true;
  scope: 'launch' | 'team' | 'autoresearch';
  repoRoot: string;
  worktreePath: string;
  detached: boolean;
  baseRef: string;
  branchName: string | null;
  teamName: string;
  workerName: string;
}

export interface EnsureWorktreeResult {
  enabled: true;
  repoRoot: string;
  worktreePath: string;
  detached: boolean;
  branchName: string | null;
  created: boolean;
  reused: boolean;
  createdBranch: boolean;
  dirty?: boolean;
}

export interface EnsureWorktreeOptions {
  allowDirtyReuse?: boolean;
}

interface GitWorktreeEntry {
  path: string;
  head: string;
  branchRef: string | null;
  detached: boolean;
}

const BRANCH_IN_USE_PATTERN = /already checked out|already used by worktree|is already checked out/i;

export const WORKTREE_ERROR_CODES = {
  WORKTREE_DIRTY: 'worktree_dirty',
  WORKTREE_OWNER_MISMATCH: 'worktree_owner_mismatch',
  WORKTREE_NOT_GIT: 'worktree_not_git',
  WORKTREE_STALE_ENTRY: 'worktree_stale_entry',
  WORKTREE_BRANCH_IN_USE: 'worktree_branch_in_use',
  WORKTREE_PATH_CONFLICT: 'worktree_path_conflict',
  WORKTREE_TARGET_MISMATCH: 'worktree_target_mismatch',
} as const;

export type WorktreeErrorCode = typeof WORKTREE_ERROR_CODES[keyof typeof WORKTREE_ERROR_CODES];

export type DirectoryType = 'empty' | 'git_worktree' | 'git_repo' | 'non_git_directory' | 'does_not_exist';

export function classifyDirectory(path: string): DirectoryType {
  if (!existsSync(path)) return 'does_not_exist';
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) return 'non_git_directory';
  } catch {
    return 'does_not_exist';
  }

  const gitDir = join(path, '.git');
  if (!existsSync(gitDir)) return 'non_git_directory';

  try {
    const gitStat = statSync(gitDir);
    if (gitStat.isFile()) {
      // .git file means this is a worktree (points to main repo)
      return 'git_worktree';
    }
    if (gitStat.isDirectory()) {
      return 'git_repo';
    }
  } catch {
    return 'non_git_directory';
  }

  return 'non_git_directory';
}

export interface WorktreeOwnerMetadata {
  team_name: string;
  worker_name: string;
  repo_root: string;
  base_ref: string;
  mode: 'detached' | 'named';
  branch_name: string | null;
  created_at: string;
  omb_version: string;
}

const WORKTREE_OWNER_FILE = '.omb-worktree-owner.json';

function writeWorktreeOwnerMetadata(
  worktreePath: string,
  meta: WorktreeOwnerMetadata,
): void {
  writeFileSync(
    join(worktreePath, WORKTREE_OWNER_FILE),
    JSON.stringify(meta, null, 2),
    'utf8',
  );
}

export function readWorktreeOwnerMetadata(
  worktreePath: string,
): WorktreeOwnerMetadata | null {
  const p = join(worktreePath, WORKTREE_OWNER_FILE);
  try {
    const raw = readFileSync(p, 'utf8');
    return JSON.parse(raw) as WorktreeOwnerMetadata;
  } catch {
    return null;
  }
}

function getOmbVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = join(dirname(__filename), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function isGitRepository(cwd: string): boolean {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf-8',
      windowsHide: true,
    });
  return result.status === 0;
}

export function sanitizePathToken(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const base = normalized || 'default';
  // Add 6-char hash of original value for collision resistance
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

function readGit(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr = typeof err.stderr === 'string'
      ? err.stderr.trim()
      : err.stderr instanceof Buffer
        ? err.stderr.toString('utf-8').trim()
        : '';
    throw new Error(stderr || `git ${args.join(' ')} failed`);
  }
}

function validateBranchName(repoRoot: string, branchName: string): void {
  const result = spawnSync('git', ['check-ref-format', '--branch', branchName], {
    cwd: repoRoot,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (result.status === 0) return;
  const stderr = (result.stderr || '').trim();
  throw new Error(stderr || `invalid_worktree_branch:${branchName}`);
}

function branchExists(repoRoot: string, branchName: string): boolean {
  const result = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  return result.status === 0;
}

export function isWorktreeDirty(worktreePath: string): boolean {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || `worktree_status_failed:${worktreePath}`);
  }
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  // Ignore our own owner metadata file in dirty detection
  const nonOwnerLines = lines.filter(line => !line.includes(WORKTREE_OWNER_FILE));
  return nonOwnerLines.length > 0;
}

export function readWorkspaceStatusLines(cwd: string): string[] {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || `workspace_status_failed:${cwd}`);
  }
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

export function assertCleanLeaderWorkspaceForWorkerWorktrees(cwd: string): void {
  const lines = readWorkspaceStatusLines(cwd);
  if (lines.length === 0) return;
  const preview = lines.slice(0, 8).join(' | ');
  throw new Error(
    `leader_workspace_dirty_for_worktrees:${resolve(cwd)}:${preview}:commit_or_stash_before_omb_team`,
  );
}

function listWorktrees(repoRoot: string): GitWorktreeEntry[] {
  const raw = readGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!raw) return [];

  const entries: GitWorktreeEntry[] = [];
  const chunks = raw
    .split(/\n\n+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const worktreeLine = lines.find((line) => line.startsWith('worktree '));
    const headLine = lines.find((line) => line.startsWith('HEAD '));
    const branchLine = lines.find((line) => line.startsWith('branch '));
    if (!worktreeLine || !headLine) continue;

    entries.push({
      path: resolve(worktreeLine.slice('worktree '.length)),
      head: headLine.slice('HEAD '.length).trim(),
      branchRef: branchLine ? branchLine.slice('branch '.length).trim() : null,
      detached: lines.includes('detached') || !branchLine,
    });
  }

  return entries;
}

function pruneStaleWorktreePath(repoRoot: string, worktreePath: string): void {
  const result = spawnSync('git', ['worktree', 'prune'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.status === 0) return;
  const stderr = (result.stderr || '').trim();
  throw new Error(stderr || `worktree_prune_failed:${worktreePath}`);
}

function resolveBranchName(input: WorktreePlanInput): string | null {
  if (!input.mode.enabled || input.mode.detached) return null;

  if (input.scope === 'launch') {
    return input.mode.name;
  }

  if (input.scope === 'autoresearch') {
    const runTag = sanitizePathToken(input.worktreeTag || 'run');
    return `autoresearch/${sanitizePathToken(input.mode.name)}/${runTag}`;
  }

  const workerName = (input.workerName || '').trim();
  if (!workerName) {
    throw new Error('team_worktree_worker_name_required');
  }

  return `${input.mode.name}/${workerName}`;
}

function resolveWorktreePath(input: WorktreePlanInput, repoRoot: string): string {
  const parent = dirname(repoRoot);
  const bucket = `${basename(repoRoot)}.omb-worktrees`;

  if (input.scope === 'launch') {
    if (!input.mode.enabled || input.mode.detached) {
      return join(parent, bucket, 'launch-detached');
    }
    return join(parent, bucket, `launch-${sanitizePathToken(input.mode.name)}`);
  }

  if (input.scope === 'autoresearch') {
    if (!input.mode.enabled || input.mode.detached) {
      throw new Error('autoresearch_worktree_requires_named_mode');
    }
    const runTag = sanitizePathToken(input.worktreeTag || 'run');
    return join(repoRoot, '.omb', 'worktrees', `autoresearch-${sanitizePathToken(input.mode.name)}-${runTag}`);
  }

  const teamName = sanitizePathToken(input.teamName || 'team');
  const workerName = sanitizePathToken(input.workerName || 'worker');
  return join(repoRoot, '.omb', 'team', teamName, 'worktrees', workerName);
}

function findWorktreeByPath(entries: GitWorktreeEntry[], worktreePath: string): GitWorktreeEntry | null {
  const resolved = resolve(worktreePath);
  return entries.find((entry) => resolve(entry.path) === resolved) || null;
}

function hasBranchInUse(entries: GitWorktreeEntry[], branchName: string, worktreePath: string): boolean {
  const expectedRef = `refs/heads/${branchName}`;
  const resolvedPath = resolve(worktreePath);
  return entries.some((entry) => entry.branchRef === expectedRef && resolve(entry.path) !== resolvedPath);
}

function resolveGitCommonDir(cwd: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (result.status !== 0) return null;
  const value = (result.stdout || '').trim();
  if (!value) return null;
  return resolve(cwd, value);
}

function readWorktreeEntryFromPath(repoRoot: string, worktreePath: string): GitWorktreeEntry | null {
  if (!existsSync(worktreePath)) return null;

  const repoCommonDir = resolveGitCommonDir(repoRoot);
  const worktreeCommonDir = resolveGitCommonDir(worktreePath);
  if (!repoCommonDir || !worktreeCommonDir || repoCommonDir !== worktreeCommonDir) {
    return null;
  }

  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (headResult.status !== 0) return null;
  const head = (headResult.stdout || '').trim();
  if (!head) return null;

  const branchResult = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf-8',
      windowsHide: true,
    });
  const branchRef = branchResult.status === 0 ? (branchResult.stdout || '').trim() : null;

  return {
    path: resolve(worktreePath),
    head,
    branchRef: branchRef || null,
    detached: !branchRef,
  };
}

export function parseWorktreeMode(args: string[]): ParsedWorktreeMode {
  let mode: WorktreeMode = { enabled: false };
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const rawArg = args[i];
    const arg = String(rawArg || '');

    if (arg === '--worktree' || arg === '-w') {
      // Bare --worktree/-w always means detached mode.
      // Named branches must use --worktree=<name> or -w=<name>.
      // Previously, space-separated --worktree <name> consumed the next
      // positional arg as a branch name, which could swallow task text.
      mode = { enabled: true, detached: true, name: null };
      continue;
    }

    if (arg.startsWith('--worktree=')) {
      const value = arg.slice('--worktree='.length).trim();
      mode = value
        ? { enabled: true, detached: false, name: value }
        : { enabled: true, detached: true, name: null };
      continue;
    }

    if (arg.startsWith('-w=')) {
      const value = arg.slice('-w='.length).trim();
      mode = value
        ? { enabled: true, detached: false, name: value }
        : { enabled: true, detached: true, name: null };
      continue;
    }

    if (arg.startsWith('-w') && arg.length > 2) {
      const value = arg.slice(2).trim();
      mode = value
        ? { enabled: true, detached: false, name: value }
        : { enabled: true, detached: true, name: null };
      continue;
    }

    remaining.push(rawArg);
  }

  return { mode, remainingArgs: remaining };
}

export function planWorktreeTarget(input: WorktreePlanInput): PlannedWorktreeTarget | { enabled: false } {
  if (!input.mode.enabled) return { enabled: false };

  const repoRoot = readGit(input.cwd, ['rev-parse', '--show-toplevel']);
  const baseRef = readGit(repoRoot, ['rev-parse', 'HEAD']);
  const branchName = resolveBranchName(input);

  if (branchName) {
    validateBranchName(repoRoot, branchName);
  }

  return {
    enabled: true,
    scope: input.scope,
    repoRoot,
    worktreePath: resolveWorktreePath(input, repoRoot),
    detached: input.mode.detached,
    baseRef,
    branchName,
    teamName: input.teamName || '',
    workerName: input.workerName || '',
  };
}

export function ensureWorktree(
  plan: PlannedWorktreeTarget | { enabled: false },
  options: EnsureWorktreeOptions = {},
): EnsureWorktreeResult | { enabled: false } {
  if (!plan.enabled) return { enabled: false };

  let allWorktrees = listWorktrees(plan.repoRoot);
  const staleAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath);
  if (staleAtPath && !existsSync(staleAtPath.path)) {
    pruneStaleWorktreePath(plan.repoRoot, staleAtPath.path);
    allWorktrees = listWorktrees(plan.repoRoot);
  }
  const existingAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath)
    ?? readWorktreeEntryFromPath(plan.repoRoot, plan.worktreePath);
  const expectedBranchRef = plan.branchName ? `refs/heads/${plan.branchName}` : null;

  if (existingAtPath) {
    // Validate owner metadata before reusing
    const ownerMeta = readWorktreeOwnerMetadata(plan.worktreePath);
    if (ownerMeta) {
      if (ownerMeta.team_name !== plan.teamName ||
          ownerMeta.worker_name !== plan.workerName) {
        throw new Error(
          `worktree_owner_mismatch: path ${plan.worktreePath} owned by team=${ownerMeta.team_name} worker=${ownerMeta.worker_name}, ` +
          `but current context is team=${plan.teamName} worker=${plan.workerName}. ` +
          `To fix: remove the stale worktree or reassign ownership, or run 'omb doctor --worktrees' for cleanup suggestions.`,
        );
      }
    }

    if (plan.detached) {
      if (!existingAtPath.detached || existingAtPath.head !== plan.baseRef) {
        throw new Error(
          `worktree_target_mismatch: path ${plan.worktreePath} HEAD or detached mode does not match expected target. ` +
          `To fix: remove the mismatched worktree, or run 'omb doctor --worktrees' for cleanup suggestions.`,
        );
      }
    } else if (existingAtPath.branchRef !== expectedBranchRef) {
      throw new Error(
        `worktree_target_mismatch: path ${plan.worktreePath} branch ${existingAtPath.branchRef} does not match expected ${expectedBranchRef}. ` +
        `To fix: remove the mismatched worktree, or run 'omb doctor --worktrees' for cleanup suggestions.`,
      );
    }

    const dirty = isWorktreeDirty(plan.worktreePath);
    if (dirty && !options.allowDirtyReuse) {
      throw new Error(
        `worktree_dirty: path ${plan.worktreePath} has uncommitted changes. ` +
        `To fix: commit or stash changes, or run 'omb doctor --worktrees' for cleanup suggestions.`,
      );
    }

    const reused = {
      enabled: true,
      repoRoot: plan.repoRoot,
      worktreePath: resolve(plan.worktreePath),
      detached: plan.detached,
      branchName: plan.branchName,
      created: false,
      reused: true,
      createdBranch: false,
      ...(dirty ? { dirty: true } : {}),
    } satisfies EnsureWorktreeResult;

    if (plan.branchName) {
      upsertCurrentTaskBaseline(plan.repoRoot, {
        branch_name: plan.branchName,
        worktree_path: reused.worktreePath,
        base_ref: plan.baseRef,
        status: 'active',
      });
    }

    return reused;
  }

  if (existsSync(plan.worktreePath)) {
    const dirType = classifyDirectory(plan.worktreePath);
    if (dirType === 'non_git_directory' || dirType === 'git_repo') {
      throw new Error(
        `worktree_not_git: path ${plan.worktreePath} exists but is not a git worktree (classified as ${dirType}). ` +
        `To fix: remove or relocate the directory, or run 'omb doctor --worktrees' for cleanup suggestions.`,
      );
    }
    throw new Error(
      `worktree_path_conflict: path ${plan.worktreePath} already exists (classified as ${dirType}). ` +
      `To fix: remove the conflicting directory, or run 'omb doctor --worktrees' for cleanup suggestions.`,
    );
  }

  if (plan.branchName && hasBranchInUse(allWorktrees, plan.branchName, plan.worktreePath)) {
    throw new Error(
      `worktree_branch_in_use: branch ${plan.branchName} is already checked out in another worktree. ` +
      `To fix: remove the other worktree first, or run 'omb doctor --worktrees' for cleanup suggestions.`,
    );
  }

  if (plan.branchName) {
    assertCurrentTaskBranchAvailable(plan.repoRoot, plan.branchName, plan.worktreePath);
  }

  mkdirSync(dirname(plan.worktreePath), { recursive: true });
  const branchAlreadyExisted = plan.branchName ? branchExists(plan.repoRoot, plan.branchName) : false;

  const addArgs = ['worktree', 'add'];
  if (plan.detached) {
    addArgs.push('--detach', plan.worktreePath, plan.baseRef);
  } else if (branchAlreadyExisted) {
    addArgs.push(plan.worktreePath, plan.branchName as string);
  } else {
    addArgs.push('-b', plan.branchName as string, plan.worktreePath, plan.baseRef);
  }

  const result = spawnSync('git', addArgs, {
    cwd: plan.repoRoot,
    encoding: 'utf-8',
      windowsHide: true,
    });

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (plan.branchName && BRANCH_IN_USE_PATTERN.test(stderr)) {
      throw new Error(
        `worktree_branch_in_use: branch ${plan.branchName} is already checked out in another worktree. ` +
        `To fix: remove the other worktree first, or run 'omb doctor --worktrees' for cleanup suggestions.`,
      );
    }
    throw new Error(stderr || `worktree_add_failed:${addArgs.join(' ')}`);
  }

  const ensured = {
    enabled: true,
    repoRoot: plan.repoRoot,
    worktreePath: resolve(plan.worktreePath),
    detached: plan.detached,
    branchName: plan.branchName,
    created: true,
    reused: false,
    createdBranch: Boolean(plan.branchName && !branchAlreadyExisted),
  } satisfies EnsureWorktreeResult;

  // Write ownership metadata
  writeWorktreeOwnerMetadata(ensured.worktreePath, {
    team_name: plan.teamName,
    worker_name: plan.workerName,
    repo_root: plan.repoRoot,
    base_ref: plan.baseRef,
    mode: plan.detached ? 'detached' : 'named',
    branch_name: plan.branchName,
    created_at: new Date().toISOString(),
    omb_version: getOmbVersion(),
  });

  // Add owner file to the worktree's info/exclude so git ignores it without
  // creating a tracked .gitignore entry (which would make the worktree dirty).
  // Use `git rev-parse --git-path` to resolve the correct path for worktrees
  // where .git is a file, not a directory.
  try {
    const excludePath = readGit(ensured.worktreePath, ['rev-parse', '--git-path', 'info/exclude']);
    if (excludePath) {
      const gitInfoDir = dirname(excludePath);
      mkdirSync(gitInfoDir, { recursive: true });
      let excludeContent = '';
      if (existsSync(excludePath)) {
        excludeContent = readFileSync(excludePath, 'utf8');
      }
      if (!excludeContent.split(/\r?\n/).includes(WORKTREE_OWNER_FILE)) {
        const appended = excludeContent
          ? (excludeContent.endsWith('\n') ? excludeContent : excludeContent + '\n') + WORKTREE_OWNER_FILE + '\n'
          : WORKTREE_OWNER_FILE + '\n';
        writeFileSync(excludePath, appended, 'utf8');
      }
    }
  } catch {
    // Non-critical: if exclude update fails, the worktree is still functional
  }

  if (plan.branchName) {
    upsertCurrentTaskBaseline(plan.repoRoot, {
      branch_name: plan.branchName,
      worktree_path: ensured.worktreePath,
      base_ref: plan.baseRef,
      status: 'active',
    });
  }

  return ensured;
}

export interface RollbackWorktreeOptions {
  /** When true, skip `git branch -D` for branches created during provisioning (ralph policy). */
  skipBranchDeletion?: boolean;
}

export async function rollbackProvisionedWorktrees(
  results: Array<EnsureWorktreeResult | { enabled: false }>,
  options: RollbackWorktreeOptions = {},
): Promise<void> {
  const created = results
    .filter((result): result is EnsureWorktreeResult => result.enabled === true && result.created)
    .reverse();

  const errors: string[] = [];

  for (const result of created) {
    try {
      await execFilePromise('git', ['worktree', 'remove', '--force', result.worktreePath], {
        cwd: result.repoRoot,
        encoding: 'utf-8',
      });
    } catch (err: unknown) {
      const stderr = ((err as Record<string, unknown>).stderr as string ?? '').trim();
      const exitCode = (err as Record<string, unknown>).code;
      errors.push(`remove:${result.worktreePath}:${stderr || `exit_${exitCode}`}`);
      continue;
    }

    if (options.skipBranchDeletion) continue;
    if (!result.createdBranch || !result.branchName) continue;

    const entriesAfterRemove = listWorktrees(result.repoRoot);
    const stillCheckedOut = hasBranchInUse(entriesAfterRemove, result.branchName, result.worktreePath);
    if (stillCheckedOut) continue;

    try {
      await execFilePromise('git', ['branch', '-D', result.branchName], {
        cwd: result.repoRoot,
        encoding: 'utf-8',
      });
    } catch (err: unknown) {
      if (branchExists(result.repoRoot, result.branchName)) {
        const stderr = ((err as Record<string, unknown>).stderr as string ?? '').trim();
        const exitCode = (err as Record<string, unknown>).code;
        errors.push(`delete_branch:${result.branchName}:${stderr || `exit_${exitCode}`}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`worktree_rollback_failed:${errors.join(' | ')}`);
  }
}

export async function removeWorktreeForce(repoRoot: string, worktreePath: string): Promise<void> {
  await execFilePromise('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
}

export interface StaleWorktreeEntry {
  path: string;
  branchRef: string | null;
  head: string;
}

export function findStaleWorktreeEntries(repoRoot: string): StaleWorktreeEntry[] {
  const entries = listWorktrees(repoRoot);
  return entries
    .filter(entry => !existsSync(entry.path))
    .map(entry => ({
      path: entry.path,
      branchRef: entry.branchRef,
      head: entry.head,
    }));
}

export function pruneStaleWorktrees(repoRoot: string): StaleWorktreeEntry[] {
  const stale = findStaleWorktreeEntries(repoRoot);
  if (stale.length === 0) return [];
  const result = spawnSync('git', ['worktree', 'prune'], {
    cwd: repoRoot,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(
      `worktree_stale_entry: failed to prune stale worktree entries: ${stderr || 'unknown error'}. ` +
      `To fix: run 'git worktree prune' manually, or use 'omb doctor --worktrees' for cleanup suggestions.`,
    );
  }
  return stale;
}
