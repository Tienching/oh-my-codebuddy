/**
 * codebuddy-trust — pre-register a directory as trusted in CodeBuddy/Claude Code's
 * shared trust database (~/.claude.json) so non-TTY launches don't deadlock on the
 * "Trust folder?" interactive dialog.
 *
 * Why this exists:
 * - CodeBuddy is a Claude Code fork; it reuses ~/.claude.json's
 *   `projects.<absolute-path>.hasTrustDialogAccepted` field as its trust gate.
 * - The trust dialog is TTY-only. spawned subprocesses (e.g. e2e test workers)
 *   that hit a fresh directory will hang forever waiting for keyboard input.
 * - Pre-writing `hasTrustDialogAccepted: true` for the target path side-steps
 *   the dialog entirely.
 *
 * Use this in two places (defense in depth):
 * 1. omb setup — pre-trust the user's repo + common parents (~/Projects, /tmp).
 * 2. Right before any spawn of a CodeBuddy/Claude Code subprocess — pre-trust
 *    the worker cwd. This catches dynamically-created paths (test fixtures,
 *    worktrees) that setup couldn't predict.
 *
 * The write is atomic (temp + rename) and tolerant: if ~/.claude.json doesn't
 * exist or is malformed, we create / repair it without throwing.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { sleepSync } from './sleep.js';

const CLAUDE_JSON = join(homedir(), '.claude.json');
const CLAUDE_JSON_LOCK = `${CLAUDE_JSON}.lock`;
const CLAUDE_JSON_LOCK_TIMEOUT_MS = 1_000;
const CLAUDE_JSON_LOCK_STALE_MS = 5_000;
const CLAUDE_JSON_LOCK_RETRY_MS = 25;

interface ClaudeJson {
  projects?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

function readClaudeJson(): ClaudeJson {
  if (!existsSync(CLAUDE_JSON)) return {};
  try {
    const raw = readFileSync(CLAUDE_JSON, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as ClaudeJson) : {};
  } catch {
    return {};
  }
}

function writeClaudeJsonAtomic(data: ClaudeJson): void {
  const dir = dirname(CLAUDE_JSON);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${CLAUDE_JSON}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, CLAUDE_JSON);
}

function maybeRecoverStaleClaudeJsonLock(): boolean {
  try {
    const info = statSync(CLAUDE_JSON_LOCK);
    if (Date.now() - info.mtimeMs > CLAUDE_JSON_LOCK_STALE_MS) {
      rmSync(CLAUDE_JSON_LOCK, { recursive: true, force: true });
      return true;
    }
  } catch {
    // best-effort stale-lock recovery only
  }
  return false;
}

function withClaudeJsonLock<T>(fn: () => T): T {
  const deadline = Date.now() + CLAUDE_JSON_LOCK_TIMEOUT_MS;
  const dir = dirname(CLAUDE_JSON_LOCK);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  while (true) {
    try {
      mkdirSync(CLAUDE_JSON_LOCK);
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (maybeRecoverStaleClaudeJsonLock()) continue;
      if (Date.now() > deadline) throw error;
      sleepSync(CLAUDE_JSON_LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      rmSync(CLAUDE_JSON_LOCK, { recursive: true, force: true });
    } catch {
      // lock cleanup is best effort
    }
  }
}

/**
 * Mark a single absolute path as trusted in CodeBuddy/Claude Code's shared DB.
 * Non-throwing: silently no-ops if the FS write fails, since trust pre-write
 * should never block the calling flow (worst case: dialog still shows).
 */
export function ensureCodebuddyTrust(absolutePath: string): boolean {
  try {
    const path = resolve(absolutePath);
    return withClaudeJsonLock(() => {
      const data = readClaudeJson();
      data.projects = data.projects ?? {};
      const existing = data.projects[path];
      if (existing && existing.hasTrustDialogAccepted === true) return true;
      data.projects[path] = {
        ...(existing ?? {}),
        hasTrustDialogAccepted: true,
      };
      writeClaudeJsonAtomic(data);
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Mark multiple paths as trusted in one atomic write — preferred when registering
 * several known directories at omb-setup time (repo root + ~/Projects + /tmp etc.).
 */
export function ensureCodebuddyTrustMany(paths: readonly string[]): number {
  try {
    return withClaudeJsonLock(() => {
      const data = readClaudeJson();
      data.projects = data.projects ?? {};
      let added = 0;
      for (const p of paths) {
        try {
          const abs = resolve(p);
          const existing = data.projects[abs];
          if (existing && existing.hasTrustDialogAccepted === true) continue;
          data.projects[abs] = { ...(existing ?? {}), hasTrustDialogAccepted: true };
          added += 1;
        } catch {
          // skip malformed paths
        }
      }
      if (added === 0) return 0;
      writeClaudeJsonAtomic(data);
      return added;
    });
  } catch {
    return 0;
  }
}

/**
 * Default set of paths omb setup should pre-trust:
 * - the repo root (where omb setup was invoked)
 * - the parent ~/Projects directory (covers all sibling repos)
 * - /tmp prefixes used by e2e tests and ephemeral worktrees
 */
export function defaultTrustedPaths(repoRoot: string): string[] {
  const home = homedir();
  return [
    resolve(repoRoot),
    join(home, 'Projects'),
    '/tmp',
  ];
}
