import {
  classifyTaskSize,
  isHeavyMode,
  type TaskSizeResult,
  type TaskSizeThresholds,
} from '../hooks/task-size-detector.js';
import {
  KEYWORD_TRIGGER_DEFINITIONS,
  compareKeywordMatches,
} from '../hooks/keyword-registry.js';

export interface KeywordMatch {
  keyword: string;
  skill: string;
  priority: number;
}

export interface TaskSizeFilterOptions {
  enabled?: boolean;
  smallWordLimit?: number;
  largeWordLimit?: number;
  suppressHeavyModesForSmallTasks?: boolean;
}

export const OMB_MAGIC_KEYWORD_ROUTER_ENV = 'OMB_MAGIC_KEYWORD_ROUTER';

function isTruthyFlag(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function isExperimentalMagicKeywordRouterEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthyFlag(env[OMB_MAGIC_KEYWORD_ROUTER_ENV]) || isTruthyFlag(env[OMB_MAGIC_KEYWORD_ROUTER_ENV]);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWordChar(ch: string | undefined): boolean {
  return Boolean(ch && /[A-Za-z0-9_]/.test(ch));
}

function keywordToPattern(keyword: string): RegExp {
  const escaped = escapeRegex(keyword);
  const startsWithWord = isWordChar(keyword[0]);
  const endsWithWord = isWordChar(keyword[keyword.length - 1]);
  const prefix = startsWithWord ? '\\b' : '';
  const suffix = endsWithWord ? '\\b' : '';
  return new RegExp(`${prefix}${escaped}${suffix}`, 'i');
}

const KEYWORD_MAP: Array<{ pattern: RegExp; skill: string; priority: number }> = KEYWORD_TRIGGER_DEFINITIONS.map((entry) => ({
  pattern: keywordToPattern(entry.keyword),
  skill: entry.skill,
  priority: entry.priority,
}));

const KEYWORDS_REQUIRING_INTENT = new Set(['team', 'swarm']);

const TEAM_SWARM_INTENT_PATTERNS: Record<'team' | 'swarm', RegExp[]> = {
  team: [
    /(?:^|[^\w])\$(?:team)\b/i,
    /\/prompts:team\b/i,
    /\b(?:use|run|start|enable|launch|invoke|activate|orchestrate|coordinate)\s+(?:a\s+|an\s+|the\s+)?team\b/i,
    /\bteam\s+(?:mode|orchestration|workflow|agents?)\b/i,
  ],
  swarm: [
    /(?:^|[^\w])\$(?:swarm)\b/i,
    /\/prompts:swarm\b/i,
    /\b(?:use|run|start|enable|launch|invoke|activate|orchestrate|coordinate)\s+(?:a\s+|an\s+|the\s+)?swarm\b/i,
    /\bswarm\s+(?:mode|orchestration|workflow|agents?)\b/i,
  ],
};

function hasExplicitPromptsInvocation(text: string): boolean {
  return /(?:^|\s)\/prompts:[\w.-]+(?=[\s.,!?;:]|$)/i.test(text);
}

function hasExplicitSkillLikeInvocation(text: string): boolean {
  return /(?:^|[^\w])\$([a-z][a-z0-9-]*)\b/i.test(text);
}

function extractExplicitSkillInvocations(text: string): KeywordMatch[] {
  const results: KeywordMatch[] = [];
  const regex = /(?:^|[^\w])\$([a-z][a-z0-9-]*)\b/gi;
  let match: RegExpExecArray | null;
  let captureStarted = false;
  let lastMatchEnd = -1;

  while ((match = regex.exec(text)) !== null) {
    const token = (match[1] ?? '').toLowerCase();
    if (!token) continue;

    const normalizedSkill = token === 'swarm' ? 'team' : token;
    const registryEntry = KEYWORD_TRIGGER_DEFINITIONS.find((entry) => entry.skill.toLowerCase() === normalizedSkill);
    if (!registryEntry) continue;

    const matchStart = match.index + match[0].lastIndexOf('$');
    if (captureStarted) {
      const between = text.slice(lastMatchEnd, matchStart);
      if (!/^\s*$/.test(between)) break;
    }

    captureStarted = true;
    lastMatchEnd = matchStart + token.length + 1;

    if (results.some((item) => item.skill === normalizedSkill)) continue;

    results.push({
      keyword: `$${token}`,
      skill: normalizedSkill,
      priority: registryEntry.priority,
    });
  }

  return results;
}

function hasIntentContextForKeyword(text: string, keyword: string): boolean {
  if (!KEYWORDS_REQUIRING_INTENT.has(keyword.toLowerCase())) return true;
  const normalizedKeyword = keyword.toLowerCase() as 'team' | 'swarm';
  return TEAM_SWARM_INTENT_PATTERNS[normalizedKeyword].some((pattern) => pattern.test(text));
}

export function detectKeywords(text: string): KeywordMatch[] {
  const explicit = extractExplicitSkillInvocations(text);
  if (hasExplicitPromptsInvocation(text) && explicit.length === 0) {
    return [];
  }
  if (explicit.length === 0 && hasExplicitSkillLikeInvocation(text)) {
    return [];
  }
  if (explicit.length > 0) {
    return explicit;
  }

  const implicit: KeywordMatch[] = [];
  for (const { pattern, skill, priority } of KEYWORD_MAP) {
    const match = text.match(pattern);
    if (!match) continue;
    if (!hasIntentContextForKeyword(text, match[0].toLowerCase())) continue;
    implicit.push({
      keyword: match[0],
      skill,
      priority,
    });
  }

  const merged: KeywordMatch[] = [];
  for (const item of implicit.sort(compareKeywordMatches)) {
    if (merged.some((existing) => existing.skill === item.skill)) continue;
    merged.push(item);
  }
  return merged;
}

export function detectPrimaryKeyword(text: string): KeywordMatch | null {
  const matches = detectKeywords(text);
  return matches.length > 0 ? matches[0] : null;
}

export function getAllKeywordsWithSizeCheck(
  text: string,
  options: TaskSizeFilterOptions = {},
): { keywords: string[]; taskSizeResult: TaskSizeResult | null; suppressedKeywords: string[] } {
  const {
    enabled = true,
    smallWordLimit = 50,
    largeWordLimit = 200,
    suppressHeavyModesForSmallTasks = true,
  } = options;

  const keywords = detectKeywords(text).map((match) => match.skill);
  if (!enabled || !suppressHeavyModesForSmallTasks || keywords.length === 0) {
    return { keywords, taskSizeResult: null, suppressedKeywords: [] };
  }

  const thresholds: TaskSizeThresholds = { smallWordLimit, largeWordLimit };
  const taskSizeResult = classifyTaskSize(text, thresholds);
  if (taskSizeResult.size !== 'small') {
    return { keywords, taskSizeResult, suppressedKeywords: [] };
  }

  const suppressedKeywords: string[] = [];
  const filteredKeywords = keywords.filter((keyword) => {
    if (!isHeavyMode(keyword)) return true;
    suppressedKeywords.push(keyword);
    return false;
  });

  return {
    keywords: filteredKeywords,
    taskSizeResult,
    suppressedKeywords,
  };
}
