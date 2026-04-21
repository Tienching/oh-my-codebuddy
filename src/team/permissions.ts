/**
 * Team Worker Permissions - Advisory RBAC for team workers
 *
 * Provides path and command scoping for team workers. Uses a deny-first
 * evaluation model with secure defaults that cannot be overridden.
 * Permissions are advisory (injected into worker prompts) — not mechanical
 * enforcement. Relies on the LLM following instructions.
 *
 */

import { isAbsolute, relative, join } from "path";

// ── Types ──────────────────────────────────────────────────────────────

export interface WorkerPermissions {
  workerName: string;
  /** Glob patterns for allowed paths. Empty = all within cwd. */
  allowedPaths: string[];
  /** Glob patterns for denied paths. Always wins over allowedPaths. */
  deniedPaths: string[];
  /** Prefixes for allowed commands. Empty = all commands. */
  allowedCommands: string[];
  /** Max file size in bytes for write operations. Infinity = no limit. */
  maxFileSize: number;
}

export interface PermissionViolation {
  path: string;
  reason: string;
}

// ── Secure defaults ────────────────────────────────────────────────────

/**
 * Always-denied path patterns that cannot be overridden.
 * These are prepended to any user-specified deniedPaths.
 */
const SECURE_DENY_DEFAULTS = [
  ".git/**",
  ".env*",
  "**/.env*",
  "**/secrets/**",
  "**/.ssh/**",
  "**/node_modules/.cache/**",
  ".omb/state/**",
  ".omb/plans/**",
];

// ── Custom glob matcher ────────────────────────────────────────────────

/**
 * Iterative glob matcher supporting *, **, and ?.
 * Specifically designed to avoid ReDoS risk from regex.
 */
function matchGlob(pattern: string, text: string): boolean {
  // Normalize separators
  const p = pattern.replace(/\\/g, "/");
  const t = text.replace(/\\/g, "/");

  let pi = 0;
  let ti = 0;
  let starPi = -1;
  let starTi = -1;
  let doubleStarPi = -1;
  let doubleStarTi = -1;

  while (ti < t.length) {
    if (pi < p.length) {
      // ** matches any depth including /
      if (p[pi] === "*" && pi + 1 < p.length && p[pi + 1] === "*") {
        doubleStarPi = pi;
        doubleStarTi = ti;
        pi += 2;
        // Skip trailing / in pattern after **
        if (pi < p.length && p[pi] === "/") pi++;
        continue;
      }

      // * matches anything except /
      if (p[pi] === "*") {
        starPi = pi;
        starTi = ti;
        pi++;
        continue;
      }

      // ? matches single non-slash
      if (p[pi] === "?" && t[ti] !== "/") {
        pi++;
        ti++;
        continue;
      }

      // Literal match
      if (p[pi] === t[ti]) {
        pi++;
        ti++;
        continue;
      }
    }

    // Backtrack to last ** if available
    if (doubleStarPi !== -1) {
      pi = doubleStarPi + 2;
      if (pi < p.length && p[pi - 1] === "/") pi++;
      doubleStarTi++;
      ti = doubleStarTi;
      continue;
    }

    // Backtrack to last * if available
    if (starPi !== -1) {
      pi = starPi + 1;
      starTi++;
      ti = starTi;
      // * doesn't match /
      if (t[ti - 1] === "/") {
        starPi = -1;
        continue;
      }
      continue;
    }

    return false;
  }

  // Consume trailing * or ** in pattern
  while (pi < p.length && (p[pi] === "*" || (p[pi] === "*" && pi + 1 < p.length && p[pi + 1] === "*"))) {
    pi++;
    if (pi < p.length && p[pi] === "*") pi++;
  }

  return pi === p.length;
}

/** Check if a path matches any of the given glob patterns. */
function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlob(pattern, filePath)) return true;
  }
  return false;
}

// ── Permission checks ──────────────────────────────────────────────────

/**
 * Check if a path is allowed for a worker.
 * Deny list always wins over allow list.
 * Paths escaping the working directory are always denied.
 */
export function isPathAllowed(
  permissions: WorkerPermissions,
  filePath: string,
  workingDirectory: string,
): boolean {
  const absPath = isAbsolute(filePath) ? filePath : join(workingDirectory, filePath);

  // Path escaping working directory = always deny
  const rel = relative(workingDirectory, absPath);
  if (rel.startsWith("..")) return false;

  // Check deny list first (always wins)
  const effectiveDenied = [...SECURE_DENY_DEFAULTS, ...permissions.deniedPaths];
  if (matchesAnyPattern(rel, effectiveDenied)) return false;
  if (matchesAnyPattern(absPath, effectiveDenied)) return false;

  // Check allow list (empty = all within cwd)
  if (permissions.allowedPaths.length === 0) return true;
  if (matchesAnyPattern(rel, permissions.allowedPaths)) return true;
  if (matchesAnyPattern(absPath, permissions.allowedPaths)) return false;

  return false;
}

/**
 * Check if a command is allowed for a worker.
 * Uses prefix matching against allowedCommands. Empty = all commands.
 */
export function isCommandAllowed(
  permissions: WorkerPermissions,
  command: string,
): boolean {
  if (permissions.allowedCommands.length === 0) return true;

  const cmd = command.trim();
  for (const allowed of permissions.allowedCommands) {
    if (cmd.startsWith(allowed)) return true;
  }
  return false;
}

// ── Defaults ───────────────────────────────────────────────────────────

/** Get permissive default permissions for a worker. */
export function getDefaultPermissions(
  workerName: string,
): WorkerPermissions {
  return {
    workerName,
    allowedPaths: [],
    deniedPaths: [],
    allowedCommands: [],
    maxFileSize: Infinity,
  };
}

/** Merge caller permissions with secure deny defaults. */
export function getEffectivePermissions(
  base?: Partial<WorkerPermissions>,
): WorkerPermissions {
  const name = base?.workerName ?? "unknown";
  return {
    workerName: name,
    allowedPaths: base?.allowedPaths ?? [],
    deniedPaths: [
      ...SECURE_DENY_DEFAULTS,
      ...(base?.deniedPaths ?? []),
    ],
    allowedCommands: base?.allowedCommands ?? [],
    maxFileSize: base?.maxFileSize ?? Infinity,
  };
}

// ── Batch check ────────────────────────────────────────────────────────

/** Check multiple paths for permission violations. */
export function findPermissionViolations(
  changedPaths: string[],
  permissions: WorkerPermissions,
  cwd: string,
): PermissionViolation[] {
  const violations: PermissionViolation[] = [];
  for (const path of changedPaths) {
    if (!isPathAllowed(permissions, path, cwd)) {
      const rel = relative(cwd, isAbsolute(path) ? path : join(cwd, path));
      violations.push({
        path,
        reason: rel.startsWith("..")
          ? "Path escapes working directory"
          : `Path denied by permission policy: ${rel}`,
      });
    }
  }
  return violations;
}

// ── Prompt formatting ──────────────────────────────────────────────────

/** Generate human-readable permission instructions for worker prompts. */
export function formatPermissionInstructions(
  permissions: WorkerPermissions,
): string {
  const lines: string[] = [
    `<worker-permissions>`,
    `Worker: ${permissions.workerName}`,
  ];

  const effective = getEffectivePermissions(permissions);

  if (effective.deniedPaths.length > 0) {
    lines.push(`Denied paths (NEVER access these):`);
    for (const p of effective.deniedPaths) {
      lines.push(`  - ${p}`);
    }
  }

  if (permissions.allowedPaths.length > 0) {
    lines.push(`Allowed paths (only modify these):`);
    for (const p of permissions.allowedPaths) {
      lines.push(`  - ${p}`);
    }
  } else {
    lines.push(`Allowed paths: all within project directory`);
  }

  if (permissions.allowedCommands.length > 0) {
    lines.push(`Allowed commands (prefix match):`);
    for (const c of permissions.allowedCommands) {
      lines.push(`  - ${c}`);
    }
  }

  if (permissions.maxFileSize < Infinity) {
    lines.push(`Max file size: ${(permissions.maxFileSize / 1024).toFixed(0)} KB`);
  }

  lines.push(`</worker-permissions>`);
  return lines.join("\n");
}
