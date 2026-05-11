import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveActiveTeamStateRoot } from './state-root.js';
import { sanitizeTeamName } from './tmux-session.js';

export type MergeTier = 'leader-online' | 'cli-interactive' | 'non-interactive';
export type MergeSessionStatus = 'pending' | 'in_progress' | 'paused' | 'completed' | 'failed';
export type MergeWorkerStatus = 'pending' | 'merging' | 'merged' | 'conflict' | 'skipped' | 'failed';

export interface MergeWorkerEntry {
  name: string;
  branch: string;
  worktreePath: string | null;
  status: MergeWorkerStatus;
  mergeCommit?: string | null;
  conflictReportPath?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface MergeSessionOptions {
  cleanup: boolean;
  detach: boolean;
  dryRun: boolean;
  only?: string | null;
  nonInteractive: boolean;
  resume?: boolean;
}

export interface MergeSessionState {
  version: 1;
  teamName: string;
  baseBranch: string;
  tier: MergeTier;
  status: MergeSessionStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
  workers: MergeWorkerEntry[];
  options: MergeSessionOptions;
  error?: string | null;
}

export interface ConflictReport {
  conflictId: string;
  teamName: string;
  workerName: string;
  branch: string;
  baseBranch: string;
  conflictingFiles: string[];
  mergeTreeOutput: string;
  suggestedCommands: string[];
  createdAt: string;
}

export interface MergeFlowOptions {
  teamName: string;
  baseBranch: string | null;
  mode: 'auto' | 'leader-online' | 'cli-interactive' | 'non-interactive' | 'resume';
  dryRun: boolean;
  cleanup: boolean;
  detach: boolean;
  onlyWorker: string | null;
  cwd: string;
  nonInteractive?: boolean;
}

export interface MergeFlowResult {
  success: boolean;
  delegated?: boolean;
  tier: MergeTier;
  sessionPath: string;
  merged: string[];
  conflicts: string[];
  skipped: string[];
  failed?: string[];
  resultPath?: string;
}

export function mergeSessionDir(teamName: string, cwd: string): string {
  const sanitized = sanitizeTeamName(teamName);
  return join(resolveActiveTeamStateRoot(cwd), 'team', sanitized, 'merge');
}

export function mergeSessionPath(teamName: string, cwd: string): string {
  return join(mergeSessionDir(teamName, cwd), 'session.json');
}

export function mergeConflictsDir(teamName: string, cwd: string): string {
  return join(mergeSessionDir(teamName, cwd), 'conflicts');
}

export function isMergeSessionState(value: unknown): value is MergeSessionState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.teamName !== 'string' || !v.teamName) return false;
  if (typeof v.baseBranch !== 'string') return false;
  if (v.tier !== 'leader-online' && v.tier !== 'cli-interactive' && v.tier !== 'non-interactive') return false;
  if (typeof v.status !== 'string') return false;
  if (!['pending', 'in_progress', 'paused', 'completed', 'failed'].includes(v.status)) return false;
  if (typeof v.startedAt !== 'string') return false;
  if (typeof v.updatedAt !== 'string') return false;
  if (!Array.isArray(v.workers)) return false;
  for (const w of v.workers) {
    if (!w || typeof w !== 'object') return false;
    const ww = w as Record<string, unknown>;
    if (typeof ww.name !== 'string' || !ww.name) return false;
    if (typeof ww.branch !== 'string') return false;
    if (typeof ww.status !== 'string') return false;
    if (!['pending', 'merging', 'merged', 'conflict', 'skipped', 'failed'].includes(ww.status)) return false;
  }
  if (!v.options || typeof v.options !== 'object') return false;
  return true;
}

export async function readMergeSession(teamName: string, cwd: string): Promise<MergeSessionState | null> {
  const p = mergeSessionPath(teamName, cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return isMergeSessionState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeMergeSession(state: MergeSessionState, cwd: string): Promise<void> {
  if (!isMergeSessionState(state)) {
    throw new Error('writeMergeSession: invalid MergeSessionState');
  }
  const p = mergeSessionPath(state.teamName, cwd);
  const dir = dirname(p);
  await mkdir(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);
  await writeFile(tmp, body, 'utf8');
  try {
    await rename(tmp, p);
  } catch (error) {
    try { await rm(tmp, { force: true }); } catch {}
    throw error;
  }
}

export async function writeConflictReport(
  report: ConflictReport,
  teamName: string,
  cwd: string,
): Promise<{ markdownPath: string; jsonPath: string }> {
  const dir = mergeConflictsDir(teamName, cwd);
  await mkdir(dir, { recursive: true });
  const safeId = report.conflictId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const jsonPath = join(dir, `${safeId}.json`);
  const markdownPath = join(dir, `${safeId}.md`);

  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  const md = [
    `# Merge Conflict: ${report.workerName}`,
    '',
    `- Team: ${report.teamName}`,
    `- Worker: ${report.workerName}`,
    `- Branch: ${report.branch}`,
    `- Base branch: ${report.baseBranch}`,
    `- Conflict ID: ${report.conflictId}`,
    `- Detected at: ${report.createdAt}`,
    '',
    '## Conflicting files',
    '',
    ...report.conflictingFiles.map((f) => `- \`${f}\``),
    '',
    '## merge-tree output',
    '',
    '```',
    report.mergeTreeOutput || '(empty)',
    '```',
    '',
    '## Suggested commands',
    '',
    ...report.suggestedCommands.map((c) => `- \`${c}\``),
    '',
  ].join('\n');

  await writeFile(markdownPath, md, 'utf8');
  return { markdownPath, jsonPath };
}
