export const OMB_EXPLORE_CMD_ENV = 'USE_OMB_EXPLORE_CMD';
export const OMB_DEBUG_ROUTING_ENV = 'OMB_DEBUG_ROUTING';

const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

import {
  isSimpleExplorationPrompt as rulesIsSimpleExploration,
  classifyTaskKind,
  matchRoutingRule,
  resolveExploreSurface,
} from './explore-routing-rules.js';

// ── Debug diagnostics ──────────────────────────────────────────────────

export interface RoutingDiagnostics {
  /** The original task description. */
  input: string;
  /** Whether routing is enabled. */
  routingEnabled: boolean;
  /** The classified task kind. */
  taskKind: string;
  /** The matched rule (null if none). */
  matchedRule: {
    id: string;
    taskKind: string;
    preferredSurface: string;
    confidence: string;
  } | null;
  /** The resolved surface. */
  resolvedSurface: 'omb-explore' | 'normal-path';
  /** Reasons the prompt was rejected from omb-explore (if applicable). */
  rejectionReasons: string[];
  /** Why the fallback surface was chosen (if applicable). */
  fallbackReason: string | null;
}

/**
 * Produce routing diagnostics for a task description.
 * Only intended for debug mode (OMB_DEBUG_ROUTING=1).
 */
export function diagnoseRouting(
  taskDescription: string,
  env: NodeJS.ProcessEnv = process.env,
): RoutingDiagnostics {
  const routingEnabled = isExploreCommandRoutingEnabled(env);
  const taskKind = classifyTaskKind(taskDescription);
  const rule = matchRoutingRule(taskDescription);
  const { surface } = resolveExploreSurface(taskDescription, { routingEnabled });

  const rejectionReasons: string[] = [];
  let fallbackReason: string | null = null;

  if (!routingEnabled) {
    rejectionReasons.push(`Routing disabled via ${OMB_EXPLORE_CMD_ENV}`);
    fallbackReason = 'Routing explicitly disabled';
  } else if (taskKind === 'unknown') {
    rejectionReasons.push('No matching exploration or mutation pattern detected');
    fallbackReason = 'Unclassified task defaults to normal-path';
  } else if (rule && rule.preferredSurface === 'normal-path') {
    if (rule.fileMutationIntent) {
      rejectionReasons.push('Task requires file mutation');
    }
    if (!rule.readOnly) {
      rejectionReasons.push('Task is not read-only');
    }
    if (rule.id === 'command-execution') {
      rejectionReasons.push('Task requires command execution with side effects');
    }
    if (rule.id === 'multi-step-verify') {
      rejectionReasons.push('Task requires multi-step verification/diagnostics');
    }
  }

  if (rule && rule.preferredSurface === 'omb-explore' && surface === 'normal-path') {
    fallbackReason = `omb-explore unavailable, falling back to ${rule.fallbackSurface}`;
  }

  return {
    input: taskDescription,
    routingEnabled,
    taskKind,
    matchedRule: rule
      ? {
          id: rule.id,
          taskKind: rule.taskKind,
          preferredSurface: rule.preferredSurface,
          confidence: rule.confidence,
        }
      : null,
    resolvedSurface: surface,
    rejectionReasons,
    fallbackReason,
  };
}

/**
 * Format routing diagnostics as a human-readable string.
 */
export function formatRoutingDiagnostics(d: RoutingDiagnostics): string {
  const lines: string[] = [
    '[routing-diag] ─────────────────────────────────',
    `[routing-diag] input: "${d.input}"`,
    `[routing-diag] routing: ${d.routingEnabled ? 'enabled' : 'disabled'}`,
    `[routing-diag] classified: ${d.taskKind}`,
  ];

  if (d.matchedRule) {
    lines.push(`[routing-diag] rule: ${d.matchedRule.id} (confidence: ${d.matchedRule.confidence})`);
    lines.push(`[routing-diag] preferred: ${d.matchedRule.preferredSurface}`);
  } else {
    lines.push('[routing-diag] rule: none');
  }

  lines.push(`[routing-diag] surface: ${d.resolvedSurface}`);

  if (d.rejectionReasons.length > 0) {
    lines.push(`[routing-diag] rejected: ${d.rejectionReasons.join('; ')}`);
  }
  if (d.fallbackReason) {
    lines.push(`[routing-diag] fallback: ${d.fallbackReason}`);
  }

  lines.push('[routing-diag] ─────────────────────────────────');
  return lines.join('\n');
}

/**
 * Check if debug routing mode is enabled.
 */
export function isDebugRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OMB_DEBUG_ROUTING_ENV]?.trim() === '1';
}

// ── Public API ─────────────────────────────────────────────────────────

export function isExploreCommandRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OMB_EXPLORE_CMD_ENV];
  if (typeof raw !== 'string') return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Determine whether a prompt is a simple exploration task.
 * Delegates to the data-driven rules table in explore-routing-rules.ts.
 */
export function isSimpleExplorationPrompt(text: string): boolean {
  return rulesIsSimpleExploration(text);
}

export function buildExploreRoutingGuidance(env: NodeJS.ProcessEnv = process.env): string {
  if (!isExploreCommandRoutingEnabled(env)) return '';

  const debugNote = isDebugRoutingEnabled(env)
    ? `\n- **Debug routing enabled** via \`${OMB_DEBUG_ROUTING_ENV}=1\`. Routing decisions are logged to stderr.`
    : '';

  return [
    `**Explore Command Preference:** enabled via \`${OMB_EXPLORE_CMD_ENV}\` (default-on; opt out with \`0\`, \`false\`, \`no\`, or \`off\`)`,
    '- Advisory steering only: agents SHOULD treat `omb explore` as the default first stop for direct inspection and SHOULD reserve `omb sparkshell` for qualifying read-only shell-native tasks.',
    '- For simple file/symbol lookups, use `omb explore` FIRST before attempting full code analysis.',
    '- When the user asks for a simple read-only exploration task (file/symbol/pattern/relationship lookup), strongly prefer `omb explore` as the default surface.',
    '- Explore examples: `omb explore --prompt "which files define TeamPolicy"`, `omb explore --prompt "find usages of buildExploreRoutingGuidance"`.',
    '- SparkShell examples: use `omb sparkshell -- rg -n "TeamPolicy" src`, `omb sparkshell -- npm test`, or `omb sparkshell --tmux-pane %12` for noisy verification, bounded shell output, or tmux-pane summaries.',
    '- Keep `omb explore` prompts narrow and concrete; prefer a single lookup goal or a small related cluster, using `--prompt` for quick asks and `--prompt-file` for longer reusable briefs.',
    '- Treat `omb explore` as a shell-only allowlisted read-only path; keep edits, tests, diagnostics, MCP/web needs, and complex shell composition on the richer normal path.',
    '- Keep implementation, refactor, test, or ambiguous broad requests on the normal Codex path.',
    '- If `omb explore` is unavailable, stalls, or fails, retry with a narrower prompt or gracefully fall back to the normal path.',
    debugNote,
  ].join("\n");
}

/**
 * Emit routing diagnostics to stderr if debug mode is enabled.
 * No-op in normal mode — does not pollute prompts or output.
 */
export function emitRoutingDiagnostics(
  taskDescription: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isDebugRoutingEnabled(env)) return;

  const diag = diagnoseRouting(taskDescription, env);
  process.stderr.write(formatRoutingDiagnostics(diag) + '\n');
}
