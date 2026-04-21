/**
 * Todo Continuation - Detects incomplete tasks and enforces work continuation
 *
 * Provides the checkIncompleteTodos() function used by the persistent-mode
 * system to determine if there are pending/in-progress tasks that should
 * prevent the agent from stopping. Also provides stop context analysis
 * (abort detection, rate limit detection, auth error detection) to ensure
 * safe escape hatches.
 *
 * Ported from oh-my-claudecode/src/hooks/todo-continuation/
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ── Types ──────────────────────────────────────────────────────────────

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: string;
  id?: string;
}

export interface Task {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  blocks?: string[];
  blockedBy?: string[];
}

export interface StopContext {
  stop_reason?: string;
  end_turn_reason?: string;
  reason?: string;
  user_requested?: boolean;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
}

export interface IncompleteTodosResult {
  count: number;
  todos: Todo[];
  total: number;
  source: "task" | "todo" | "both" | "none";
}

// ── Stop context analysis ──────────────────────────────────────────────

const ABORT_PATTERNS = [
  /user\s*abort/i,
  /user\s*cancel/i,
  /user\s*interrupt/i,
  /cancelled\s*by\s*user/i,
  /interrupted\s*by\s*user/i,
  /stop\s*requested/i,
];

const CANCEL_COMMAND_PATTERNS = [
  /^\/cancel/i,
  /\$cancel\b/i,
  /\bcancel\s+mode\b/i,
  /\bstop\s+mode\b/i,
  /\bend\s+mode\b/i,
];

const RATE_LIMIT_PATTERNS = [
  /429/,
  /rate\s*limit/i,
  /quota\s*exceeded/i,
  /too\s*many\s*requests/i,
  /usage\s*limit/i,
  /capacity\s*exceeded/i,
];

const AUTH_ERROR_PATTERNS = [
  /401/,
  /403/,
  /unauthorized/i,
  /forbidden/i,
  /invalid\s*api\s*key/i,
  /expired\s*token/i,
  /authentication\s*failed/i,
  /access\s*denied/i,
  /credential/i,
];

const CONTEXT_LIMIT_PATTERNS = [
  /context\s*(window|length|size)\s*exceeded/i,
  /maximum\s*context/i,
  /token\s*limit/i,
  /context\s*overflow/i,
  /max.*tokens?\s*reached/i,
];

/** Detects user-initiated abort/cancel from stop context. */
export function isUserAbort(ctx: StopContext): boolean {
  const reason =
    ctx.stop_reason ?? ctx.reason ?? ctx.end_turn_reason ?? "";
  const prompt = ctx.prompt ?? "";

  for (const pattern of ABORT_PATTERNS) {
    if (pattern.test(reason) || pattern.test(prompt)) return true;
  }

  if (ctx.user_requested === true) return true;

  return false;
}

/** Detects explicit cancel commands (stricter than user abort). */
export function isExplicitCancelCommand(ctx: StopContext): boolean {
  const prompt = ctx.prompt ?? "";
  for (const pattern of CANCEL_COMMAND_PATTERNS) {
    if (pattern.test(prompt.trim())) return true;
  }
  return false;
}

/** Detects rate limit stops (prevents infinite retry). */
export function isRateLimitStop(ctx: StopContext): boolean {
  const reason =
    ctx.stop_reason ?? ctx.reason ?? ctx.end_turn_reason ?? "";
  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(reason)) return true;
  }
  return false;
}

/** Detects authentication errors (prevents infinite retry). */
export function isAuthenticationError(ctx: StopContext): boolean {
  const reason =
    ctx.stop_reason ?? ctx.reason ?? ctx.end_turn_reason ?? "";
  for (const pattern of AUTH_ERROR_PATTERNS) {
    if (pattern.test(reason)) return true;
  }
  return false;
}

/** Detects context window exhaustion (prevents deadlock with persistent-mode). */
export function isContextLimitStop(ctx: StopContext): boolean {
  const reason =
    ctx.stop_reason ?? ctx.reason ?? ctx.end_turn_reason ?? "";
  for (const pattern of CONTEXT_LIMIT_PATTERNS) {
    if (pattern.test(reason)) return true;
  }
  return false;
}

// ── Todo/Task reading ──────────────────────────────────────────────────

/** Reads todos from the legacy .omb/state/todos.json format. */
function readLegacyTodos(stateDir: string): Todo[] {
  const path = join(stateDir, "todos.json");
  if (!existsSync(path)) return [];

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (t: unknown) =>
          typeof t === "object" && t !== null && "content" in t && "status" in t,
      )
      .map((t: Record<string, unknown>) => ({
        content: String(t.content ?? ""),
        status: String(t.status ?? "pending") as Todo["status"],
        priority: t.priority ? String(t.priority) : undefined,
        id: t.id ? String(t.id) : undefined,
      }));
  } catch {
    return [];
  }
}

/** Reads tasks from the new .omb/state/tasks/ directory format. */
function readTaskFiles(tasksDir: string): Task[] {
  if (!existsSync(tasksDir)) return [];

  try {
    const { readdirSync } = require("fs");
    const files = readdirSync(tasksDir).filter((f: string) =>
      f.endsWith(".json"),
    );

    const tasks: Task[] = [];
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(tasksDir, file), "utf-8"));
        if (raw && typeof raw === "object" && raw.id && raw.subject && raw.status) {
          tasks.push({
            id: String(raw.id),
            subject: String(raw.subject),
            description: raw.description ? String(raw.description) : undefined,
            activeForm: raw.activeForm ? String(raw.activeForm) : undefined,
            status: String(raw.status) as Task["status"],
            blocks: Array.isArray(raw.blocks) ? raw.blocks : undefined,
            blockedBy: Array.isArray(raw.blockedBy) ? raw.blockedBy : undefined,
          });
        }
      } catch {
        // Skip malformed task files
      }
    }
    return tasks;
  } catch {
    return [];
  }
}

// ── Main check function ────────────────────────────────────────────────

/**
 * Checks for incomplete todos/tasks. Returns the count and list of
 * incomplete items from both the new Task system and legacy todo system.
 */
export function checkIncompleteTodos(
  cwd: string,
  sessionId?: string,
): IncompleteTodosResult {
  const stateDir = join(cwd, ".omb", "state");

  // Check new Task system first (priority)
  const tasksDir = sessionId
    ? join(stateDir, "tasks", sessionId)
    : join(stateDir, "tasks");
  const tasks = readTaskFiles(tasksDir);
  const incompleteTasks = tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  );

  // Check legacy todo system
  const legacyTodos = readLegacyTodos(stateDir);
  const incompleteLegacyTodos = legacyTodos.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  );

  // Merge results (Task system takes priority)
  const hasTasks = incompleteTasks.length > 0;
  const hasLegacy = incompleteLegacyTodos.length > 0;

  const incompleteTodos: Todo[] = [
    ...incompleteTasks.map((t) => ({
      content: t.subject,
      status: t.status as Todo["status"],
      id: t.id,
    })),
    ...incompleteLegacyTodos.map((t) => ({
      content: `[todo] ${t.content}`,
      status: t.status,
      id: t.id,
    })),
  ];

  const total = tasks.length + legacyTodos.length;

  return {
    count: incompleteTodos.length,
    todos: incompleteTodos,
    total,
    source: hasTasks && hasLegacy
      ? "both"
      : hasTasks
        ? "task"
        : hasLegacy
          ? "todo"
          : "none",
  };
}

/**
 * Gets the next pending todo (prefers in_progress over pending).
 */
export function getNextPendingTodo(
  result: IncompleteTodosResult,
): Todo | null {
  const inProgress = result.todos.find((t) => t.status === "in_progress");
  if (inProgress) return inProgress;

  const pending = result.todos.find((t) => t.status === "pending");
  return pending ?? null;
}

/**
 * Checks if a stop should be blocked due to incomplete todos.
 * Returns true if the stop should be blocked, false if it should proceed.
 */
export function shouldBlockForTodos(
  cwd: string,
  stopContext: StopContext,
  sessionId?: string,
): { block: boolean; reason: string; nextTodo?: Todo } {
  // Escape hatches: never block on these conditions
  if (isUserAbort(stopContext)) {
    return { block: false, reason: "user_abort" };
  }
  if (isExplicitCancelCommand(stopContext)) {
    return { block: false, reason: "explicit_cancel" };
  }
  if (isRateLimitStop(stopContext)) {
    return { block: false, reason: "rate_limit" };
  }
  if (isAuthenticationError(stopContext)) {
    return { block: false, reason: "auth_error" };
  }
  if (isContextLimitStop(stopContext)) {
    return { block: false, reason: "context_limit" };
  }

  // Check for incomplete todos
  const result = checkIncompleteTodos(cwd, sessionId);
  if (result.count === 0) {
    return { block: false, reason: "no_incomplete_todos" };
  }

  const nextTodo = getNextPendingTodo(result);
  return {
    block: true,
    reason: `${result.count} incomplete task(s) remain`,
    nextTodo: nextTodo ?? undefined,
  };
}
