/**
 * Persistent Mode Hook - Blocks Stop events when persistent modes are active
 *
 * Priority-ordered mode dispatcher that runs on every Stop event.
 * Checks ralph, ultrawork, team, ralplan, autopilot, and todo-continuation
 * to determine if the agent should be forced to continue working.
 *
 * Includes critical escape hatches: user abort, rate limit, auth errors,
 * context limits, and explicit cancel commands.
 *
 * Ported from oh-my-claudecode/src/hooks/persistent-mode/
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  isUserAbort,
  isExplicitCancelCommand,
  isRateLimitStop,
  isAuthenticationError,
  isContextLimitStop,
  checkIncompleteTodos,
  getNextPendingTodo,
  type StopContext,
} from "../todo-continuation/index.js";

// ── Types ──────────────────────────────────────────────────────────────

export type PersistentMode =
  | "ralph"
  | "ultrawork"
  | "todo-continuation"
  | "autopilot"
  | "team"
  | "ralplan"
  | "none";

export interface PersistentModeResult {
  shouldBlock: boolean;
  message: string;
  mode: PersistentMode;
  metadata?: {
    iteration?: number;
    maxIterations?: number;
    reinforcementCount?: number;
    todoCount?: number;
    phase?: string;
    tasksCompleted?: number;
    tasksTotal?: number;
  };
}

// ── State reading ──────────────────────────────────────────────────────

function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

interface RalphState {
  active?: boolean;
  iteration?: number;
  max_iterations?: number;
  prompt?: string;
  session_id?: string;
}

interface UltraworkState {
  active?: boolean;
  original_prompt?: string;
  reinforcement_count?: number;
}

interface TeamState {
  active?: boolean;
  phase?: string;
  teamName?: string;
  stop_breaker_count?: number;
  stop_breaker_last_reset?: string;
}

interface RalplanState {
  active?: boolean;
  phase?: string;
  stop_breaker_count?: number;
  stop_breaker_last_reset?: string;
}

interface AutopilotState {
  active?: boolean;
  phase?: string;
}

// ── Circuit breaker ────────────────────────────────────────────────────

const TEAM_STOP_BREAKER_MAX = 20;
const TEAM_STOP_BREAKER_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const RALPLAN_STOP_BREAKER_MAX = 30;
const RALPLAN_STOP_BREAKER_WINDOW_MS = 45 * 60 * 1000; // 45 minutes

function isCircuitBreakerTripped(
  count: number,
  lastReset: string | undefined,
  maxCount: number,
  windowMs: number,
): boolean {
  if (count < maxCount) return false;
  if (!lastReset) return true;
  const elapsed = Date.now() - new Date(lastReset).getTime();
  return elapsed < windowMs;
}

// ── Ralph check ────────────────────────────────────────────────────────

function checkRalph(
  stateDir: string,
  sessionId?: string,
): PersistentModeResult {
  const state = readJsonFile<RalphState>(
    join(stateDir, "ralph-state.json"),
  );
  if (!state?.active) {
    return { shouldBlock: false, message: "", mode: "none" };
  }

  // Session isolation
  if (sessionId && state.session_id && state.session_id !== sessionId) {
    return { shouldBlock: false, message: "", mode: "none" };
  }

  const iteration = state.iteration ?? 0;
  const maxIterations = state.max_iterations ?? 50;
  const prompt = state.prompt ?? "";

  // Auto-extend soft limit
  const effectiveMax =
    iteration >= maxIterations ? maxIterations + 10 : maxIterations;

  // Hard limit (never exceed 100)
  if (iteration >= 100) {
    return {
      shouldBlock: false,
      message: `[omb] Ralph hard iteration limit reached (${iteration}/100). Stopping.`,
      mode: "ralph",
      metadata: { iteration, maxIterations: 100 },
    };
  }

  const message = [
    `<ralph-continuation>`,
    `Ralph iteration ${iteration}/${effectiveMax}.`,
    `Original task: "${prompt.slice(0, 120)}${prompt.length > 120 ? "..." : ""}"`,
    `Continue working. Say "/cancel" or "cancel mode" to stop.`,
    `</ralph-continuation>`,
  ].join("\n");

  return {
    shouldBlock: true,
    message,
    mode: "ralph",
    metadata: { iteration, maxIterations: effectiveMax },
  };
}

// ── Ultrawork check ────────────────────────────────────────────────────

function checkUltrawork(stateDir: string): PersistentModeResult {
  const state = readJsonFile<UltraworkState>(
    join(stateDir, "ultrawork-state.json"),
  );
  if (!state?.active) {
    return { shouldBlock: false, message: "", mode: "none" };
  }

  const reinforcementCount = (state.reinforcement_count ?? 0) + 1;

  const message = [
    `<ultrawork-continuation>`,
    `Ultrawork reinforcement #${reinforcementCount}.`,
    `Original task: "${(state.original_prompt ?? "").slice(0, 120)}"`,
    `Continue parallel work. Say "/cancel" to stop.`,
    `</ultrawork-continuation>`,
  ].join("\n");

  return {
    shouldBlock: true,
    message,
    mode: "ultrawork",
    metadata: { reinforcementCount },
  };
}

// ── Team check ─────────────────────────────────────────────────────────

const ACTIVE_TEAM_PHASES = new Set([
  "team-plan",
  "team-prd",
  "team-exec",
  "team-verify",
  "team-fix",
]);

const TERMINAL_TEAM_PHASES = new Set([
  "complete",
  "failed",
  "cancelled",
]);

function checkTeam(stateDir: string): PersistentModeResult {
  const state = readJsonFile<TeamState>(
    join(stateDir, "team-state.json"),
  );
  if (!state?.active) {
    return { shouldBlock: false, message: "", mode: "none" };
  }

  const phase = state.phase ?? "";

  // Terminal phases allow stop
  if (TERMINAL_TEAM_PHASES.has(phase)) {
    return { shouldBlock: false, message: "", mode: "none" };
  }

  // Only block on known active phases (fail-open for unknown)
  if (!ACTIVE_TEAM_PHASES.has(phase)) {
    return { shouldBlock: false, message: "", mode: "none" };
  }

  // Circuit breaker
  const breakerCount = state.stop_breaker_count ?? 0;
  const breakerLastReset = state.stop_breaker_last_reset;
  if (
    isCircuitBreakerTripped(
      breakerCount,
      breakerLastReset,
      TEAM_STOP_BREAKER_MAX,
      TEAM_STOP_BREAKER_WINDOW_MS,
    )
  ) {
    return {
      shouldBlock: false,
      message: `[omb] Team circuit breaker tripped (${breakerCount} reinforcements in 5 min). Allowing stop.`,
      mode: "team",
    };
  }

  const message = [
    `<team-continuation>`,
    `Team phase: ${phase}.`,
    `Team "${state.teamName ?? ""}" is still active.`,
    `Continue coordinating. Say "/cancel" to force stop.`,
    `</team-continuation>`,
  ].join("\n");

  return {
    shouldBlock: true,
    message,
    mode: "team",
    metadata: { phase },
  };
}

// ── Ralplan check ──────────────────────────────────────────────────────

function checkRalplan(stateDir: string): PersistentModeResult {
  const state = readJsonFile<RalplanState>(
    join(stateDir, "ralplan-state.json"),
  );
  if (!state?.active) {
    return { shouldBlock: false, message: "", mode: "none" };
  }

  const phase = state.phase ?? "";

  // Terminal phases
  if (phase === "complete" || phase === "cancelled") {
    return { shouldBlock: false, message: "", mode: "none" };
  }

  // Circuit breaker
  const breakerCount = state.stop_breaker_count ?? 0;
  const breakerLastReset = state.stop_breaker_last_reset;
  if (
    isCircuitBreakerTripped(
      breakerCount,
      breakerLastReset,
      RALPLAN_STOP_BREAKER_MAX,
      RALPLAN_STOP_BREAKER_WINDOW_MS,
    )
  ) {
    return {
      shouldBlock: false,
      message: `[omb] Ralplan circuit breaker tripped. Allowing stop.`,
      mode: "ralplan",
    };
  }

  const message = [
    `<ralplan-continuation>`,
    `Ralplan phase: ${phase}. Planning is still in progress.`,
    `Continue. Say "/cancel" to force stop.`,
    `</ralplan-continuation>`,
  ].join("\n");

  return {
    shouldBlock: true,
    message,
    mode: "ralplan",
    metadata: { phase },
  };
}

// ── Autopilot check ────────────────────────────────────────────────────

function checkAutopilot(stateDir: string): PersistentModeResult {
  const state = readJsonFile<AutopilotState>(
    join(stateDir, "autopilot-state.json"),
  );
  if (!state?.active) {
    return { shouldBlock: false, message: "", mode: "none" };
  }

  const message = [
    `<autopilot-continuation>`,
    `Autopilot phase: ${state.phase ?? "active"}.`,
    `Continue autonomous execution. Say "/cancel" to stop.`,
    `</autopilot-continuation>`,
  ].join("\n");

  return {
    shouldBlock: true,
    message,
    mode: "autopilot",
  };
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Determines whether a Stop event should be blocked.
 * Runs through priority-ordered mode checks with escape hatches.
 */
export function shouldBlockStop(
  cwd: string,
  stopContext: StopContext,
  sessionId?: string,
): PersistentModeResult {
  // ═══════════════════════════════════════════════════════════════════
  // ESCAPE HATCHES (highest priority) — never block on these
  // ═══════════════════════════════════════════════════════════════════
  if (isUserAbort(stopContext)) {
    return { shouldBlock: false, message: "User abort detected.", mode: "none" };
  }
  if (isExplicitCancelCommand(stopContext)) {
    return {
      shouldBlock: false,
      message: "Explicit cancel command detected.",
      mode: "none",
    };
  }
  if (isRateLimitStop(stopContext)) {
    return {
      shouldBlock: false,
      message: "Rate limit stop detected — not blocking.",
      mode: "none",
    };
  }
  if (isAuthenticationError(stopContext)) {
    return {
      shouldBlock: false,
      message: "Authentication error detected — not blocking.",
      mode: "none",
    };
  }
  if (isContextLimitStop(stopContext)) {
    return {
      shouldBlock: false,
      message: "Context limit stop detected — not blocking.",
      mode: "none",
    };
  }

  const stateDir = join(cwd, ".omb", "state");

  // ═══════════════════════════════════════════════════════════════════
  // Priority 1: Ralph loop
  // ═══════════════════════════════════════════════════════════════════
  const ralphResult = checkRalph(stateDir, sessionId);
  if (ralphResult.shouldBlock) return ralphResult;

  // ═══════════════════════════════════════════════════════════════════
  // Priority 1.5: Autopilot
  // ═══════════════════════════════════════════════════════════════════
  const autopilotResult = checkAutopilot(stateDir);
  if (autopilotResult.shouldBlock) return autopilotResult;

  // ═══════════════════════════════════════════════════════════════════
  // Priority 1.7: Team pipeline
  // ═══════════════════════════════════════════════════════════════════
  const teamResult = checkTeam(stateDir);
  if (teamResult.shouldBlock) return teamResult;

  // ═══════════════════════════════════════════════════════════════════
  // Priority 1.8: Ralplan
  // ═══════════════════════════════════════════════════════════════════
  const ralplanResult = checkRalplan(stateDir);
  if (ralplanResult.shouldBlock) return ralplanResult;

  // ═══════════════════════════════════════════════════════════════════
  // Priority 2: Ultrawork
  // ═══════════════════════════════════════════════════════════════════
  const ultraworkResult = checkUltrawork(stateDir);
  if (ultraworkResult.shouldBlock) return ultraworkResult;

  // ═══════════════════════════════════════════════════════════════════
  // Priority 3: Todo continuation
  // ═══════════════════════════════════════════════════════════════════
  const todoResult = checkIncompleteTodos(cwd, sessionId);
  if (todoResult.count > 0) {
    const nextTodo = getNextPendingTodo(todoResult);
    const message = [
      `<todo-continuation>`,
      `${todoResult.count} incomplete task(s) remain.`,
      nextTodo
        ? `Next: "${nextTodo.content}" (${nextTodo.status})`
        : "",
      `Continue working. Say "/cancel" to force stop.`,
      `</todo-continuation>`,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      shouldBlock: true,
      message,
      mode: "todo-continuation",
      metadata: { todoCount: todoResult.count },
    };
  }

  // No blocking needed
  return { shouldBlock: false, message: "", mode: "none" };
}
