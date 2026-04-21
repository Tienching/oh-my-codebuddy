/**
 * Explore Routing Rules for oh-my-codebuddy
 *
 * Data-driven routing table that determines whether a task should
 * be routed to `omb explore` (read-only, shell-only) or the normal
 * CodeBuddy path (full tool access). Extracted from the regex-based
 * heuristics in explore-routing.ts for maintainability and testability.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface ExploreRoutingRule {
  /** Unique identifier for this rule. */
  id: string;
  /** Kind of task this rule matches. */
  taskKind: string;
  /** Whether the task is purely read-only. */
  readOnly: boolean;
  /** Whether file mutation is intended. */
  fileMutationIntent: boolean;
  /** How confident this rule is in its routing decision. */
  confidence: "high" | "medium" | "low";
  /** Preferred execution surface for this task kind. */
  preferredSurface: "omb-explore" | "normal-path";
  /** Fallback surface if preferred is unavailable. */
  fallbackSurface: "omb-explore" | "normal-path";
  /** Human-readable description of when this rule applies. */
  description: string;
}

// ── Rules table ────────────────────────────────────────────────────────

export const EXPLORE_ROUTING_RULES: ExploreRoutingRule[] = [
  {
    id: "symbol-lookup",
    taskKind: "symbol_lookup",
    readOnly: true,
    fileMutationIntent: false,
    confidence: "high",
    preferredSurface: "omb-explore",
    fallbackSurface: "normal-path",
    description:
      "Find a symbol definition, usage, or reference. Single lookup goal.",
  },
  {
    id: "file-relation",
    taskKind: "file_relation",
    readOnly: true,
    fileMutationIntent: false,
    confidence: "high",
    preferredSurface: "omb-explore",
    fallbackSurface: "normal-path",
    description:
      "Understand how files relate to each other, import/export chains, module structure.",
  },
  {
    id: "read-only-grep",
    taskKind: "read_only_search",
    readOnly: true,
    fileMutationIntent: false,
    confidence: "high",
    preferredSurface: "omb-explore",
    fallbackSurface: "normal-path",
    description:
      "Search for a pattern, grep for a string, list files matching a glob.",
  },
  {
    id: "architecture-overview",
    taskKind: "architecture",
    readOnly: true,
    fileMutationIntent: false,
    confidence: "medium",
    preferredSurface: "omb-explore",
    fallbackSurface: "normal-path",
    description:
      "High-level architecture question, module diagram, dependency overview.",
  },
  {
    id: "code-change",
    taskKind: "code_modification",
    readOnly: false,
    fileMutationIntent: true,
    confidence: "high",
    preferredSurface: "normal-path",
    fallbackSurface: "normal-path",
    description:
      "Any task involving code modification: implement, edit, refactor, fix, patch.",
  },
  {
    id: "command-execution",
    taskKind: "run_command",
    readOnly: false,
    fileMutationIntent: false,
    confidence: "high",
    preferredSurface: "normal-path",
    fallbackSurface: "normal-path",
    description:
      "Run a build, test, lint, or other command that may have side effects.",
  },
  {
    id: "multi-step-verify",
    taskKind: "multi_step_verification",
    readOnly: false,
    fileMutationIntent: false,
    confidence: "medium",
    preferredSurface: "normal-path",
    fallbackSurface: "normal-path",
    description:
      "Multi-step verification requiring tool execution, test runs, or diagnostics.",
  },
];

// ── Regex patterns for prompt classification ────────────────────────────

const SIMPLE_EXPLORATION_PATTERNS: RegExp[] = [
  /\b(where|find|locate|search|grep|ripgrep)\b/i,
  /\b(file|files|path|paths|symbol|symbols|usage|usages|reference|references)\b/i,
  /\b(pattern|patterns|match|matches|matching)\b/i,
  /\bhow does\b/i,
  /\bwhich\b.*\b(contain|contains|define|defines|use|uses)\b/i,
  /\b(read[- ]only|explor(e|ation)|inspect|lookup|look up|map)\b/i,
];

const NON_EXPLORATION_PATTERNS: RegExp[] = [
  /\b(implement|write|edit|modify|change|refactor|fix|patch|add|remove|delete)\b/i,
  /\b(build|create)\b.*\b(feature|system|workflow|integration|module)\b/i,
  /\b(migrate|rewrite|overhaul|redesign)\b/i,
  /\b(test|lint|typecheck|compile|deploy)\b/i,
];

/**
 * Determine whether a prompt is a simple exploration task.
 * Returns true if the text matches exploration patterns and does NOT
 * match mutation patterns. This is the same logic that was previously
 * inline in explore-routing.ts.
 */
export function isSimpleExplorationPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (NON_EXPLORATION_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
  return SIMPLE_EXPLORATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// ── Matching ───────────────────────────────────────────────────────────

/** Pattern keywords that signal read-only exploration intent. */
const EXPLORATION_KEYWORDS: ReadonlyArray<string> = [
  "where",
  "find",
  "locate",
  "search",
  "grep",
  "ripgrep",
  "file",
  "files",
  "path",
  "paths",
  "symbol",
  "symbols",
  "usage",
  "usages",
  "reference",
  "references",
  "pattern",
  "patterns",
  "match",
  "matches",
  "matching",
  "how does",
  "which",
  "read-only",
  "explore",
  "exploration",
  "inspect",
  "lookup",
  "look up",
  "map",
];

/** Pattern keywords that signal mutation intent (overrides exploration). */
const MUTATION_KEYWORDS: ReadonlyArray<string> = [
  "implement",
  "write",
  "edit",
  "modify",
  "change",
  "refactor",
  "fix",
  "patch",
  "add",
  "remove",
  "delete",
  "build",
  "create",
  "feature",
  "system",
  "workflow",
  "integration",
  "module",
  "migrate",
  "rewrite",
  "overhaul",
  "redesign",
  "test",
  "lint",
  "typecheck",
  "compile",
  "deploy",
];

/**
 * Classify a task description into a task kind for routing.
 */
export function classifyTaskKind(description: string): string {
  const text = description.toLowerCase().trim();
  if (!text) return "unknown";

  // Mutation keywords take priority — any mutation intent → normal path
  const hasMutation = MUTATION_KEYWORDS.some((kw) => text.includes(kw));
  if (hasMutation) return "code_modification";

  // Check for command execution intent
  if (/\b(run|execute|launch|start)\b/i.test(text)) return "run_command";

  // Check for multi-step verification
  if (/\b(verify|validate|check|diagnose)\b/i.test(text)) return "multi_step_verification";

  // Check for exploration intent
  const hasExploration = EXPLORATION_KEYWORDS.some((kw) => text.includes(kw));
  if (hasExploration) {
    // Determine specific kind
    if (/\b(symbol|definition|usage|reference)\b/i.test(text)) return "symbol_lookup";
    if (/\b(relat|import|export|depend|module)\b/i.test(text)) return "file_relation";
    if (/\b(search|grep|find|pattern|match)\b/i.test(text)) return "read_only_search";
    if (/\b(architect|overview|structur|diagram)\b/i.test(text)) return "architecture";
    return "read_only_search"; // Default exploration
  }

  return "unknown";
}

/**
 * Match a task description against the routing rules table.
 * Returns the best matching rule, or null if no match.
 */
export function matchRoutingRule(
  taskDescription: string,
): ExploreRoutingRule | null {
  const kind = classifyTaskKind(taskDescription);
  return EXPLORE_ROUTING_RULES.find((r) => r.taskKind === kind) ?? null;
}

/**
 * Determine the preferred surface for a task description.
 * Falls back to normal-path if routing is disabled or no rule matches.
 */
export function resolveExploreSurface(
  taskDescription: string,
  options: { routingEnabled?: boolean } = {},
): { surface: "omb-explore" | "normal-path"; rule: ExploreRoutingRule | null } {
  if (options.routingEnabled === false) {
    return { surface: "normal-path", rule: null };
  }

  const rule = matchRoutingRule(taskDescription);
  if (!rule) return { surface: "normal-path", rule: null };

  return { surface: rule.preferredSurface, rule };
}
