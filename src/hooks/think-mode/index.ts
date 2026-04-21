/**
 * Think Mode Hook - Detects "think" keywords and switches to high-reasoning model
 *
 * On UserPromptSubmit, detects keywords like "think", "ultrathink", "deep think"
 * and signals that the model should switch to a high-reasoning variant with
 * extended thinking budget.
 *
 * Ported from oh-my-claudecode/src/hooks/think-mode/
 */

// ── Types ──────────────────────────────────────────────────────────────

export type ThinkLevel = "none" | "think" | "ultrathink";

export interface ThinkModeState {
  requested: boolean;
  level: ThinkLevel;
  originalModel?: string;
  targetModel?: string;
}

export interface ThinkModeResult {
  shouldSwitch: boolean;
  level: ThinkLevel;
  targetModel?: string;
  reasoningEffort?: "low" | "medium" | "high";
  message?: string;
}

// ── Keyword detection ──────────────────────────────────────────────────

/** Strips fenced and inline code blocks from prompt text to avoid false positives. */
function stripCodeBlocks(text: string): string {
  // Strip fenced code blocks
  let result = text.replace(/```[\s\S]*?```/g, "");
  // Strip inline code
  result = result.replace(/`[^`]*`/g, "");
  return result;
}

const THINK_KEYWORDS = [
  /\bthink\s+(about|carefully|deeply|hard|through|more)\b/i,
  /\bthink\b\s+(before|first|then)\b/i,
  /\blet'?s?\s+think\b/i,
  /\breason\s+(through|about|carefully)\b/i,
  /\breason\s+step\s+by\s+step\b/i,
  /\bthink\s+step\s+by\s+step\b/i,
  /\bthink\s+deeply\b/i,
  /\bdeep\s+think(?:ing)?\b/i,
  /\bthink\s+carefully\b/i,
  /\b仔细想想\b/,
  /\b深入思考\b/,
  /\b思考一下\b/,
  /\bよく考えて\b/,
  /\b深く考え\b/,
  /\b깊이 생각\b/,
  /\b신중하게 생각\b/,
];

const ULTRATHINK_KEYWORDS = [
  /\bultrathink\b/i,
  /\bthink\s+very\s+(hard|deeply|carefully)\b/i,
  /\bmaximum\s+reasoning\b/i,
  /\bdeep\s+reasoning\b/i,
  /\bextended\s+thinking\b/i,
  /\b深度推理\b/,
  /\b超深度思考\b/,
  /\b最强思考\b/,
  /\b究極の思考\b/,
  /\b최대 추론\b/,
];

/** Detects think-mode keywords in the user prompt. */
export function detectThinkLevel(promptText: string): ThinkLevel {
  const cleaned = stripCodeBlocks(promptText);

  // Check ultrathink first (higher priority)
  for (const pattern of ULTRATHINK_KEYWORDS) {
    if (pattern.test(cleaned)) return "ultrathink";
  }

  // Then check regular think keywords
  for (const pattern of THINK_KEYWORDS) {
    if (pattern.test(cleaned)) return "think";
  }

  return "none";
}

// ── Model resolution ───────────────────────────────────────────────────

/**
 * Resolves the target model and reasoning effort for think mode.
 * In OMB, this uses the model configuration from .omb-config.json
 * to determine the frontier model.
 */
export function resolveThinkModeModel(
  level: ThinkLevel,
  currentModel?: string,
  frontierModel?: string,
): ThinkModeResult {
  if (level === "none") {
    return { shouldSwitch: false, level: "none" };
  }

  // If already on frontier model, just adjust reasoning effort
  const targetModel = frontierModel ?? currentModel;
  const reasoningEffort: "low" | "medium" | "high" =
    level === "ultrathink" ? "high" : "medium";

  const message =
    level === "ultrathink"
      ? `[omb] Ultrathink mode activated — using ${targetModel} with maximum reasoning effort.`
      : `[omb] Think mode activated — using ${targetModel} with enhanced reasoning effort.`;

  return {
    shouldSwitch: true,
    level,
    targetModel,
    reasoningEffort,
    message,
  };
}

// ── Hook integration ───────────────────────────────────────────────────

/**
 * Process a UserPromptSubmit event for think mode detection.
 * Returns a ThinkModeResult indicating whether model switching is needed.
 */
export function processUserPromptForThinkMode(
  promptText: string,
  currentModel?: string,
  frontierModel?: string,
): ThinkModeResult {
  const level = detectThinkLevel(promptText);
  return resolveThinkModeModel(level, currentModel, frontierModel);
}
