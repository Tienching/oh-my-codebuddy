/**
 * Model Router
 *
 * Main routing engine that determines which model tier to use for a given task.
 * Combines signal extraction, scoring, and rules evaluation.
 *
 * Output uses OMB model types (spark/standard/frontier/inherit),
 * includes reasoningEffort in all routing decisions, and uses
 * OMB model resolution (getSparkDefaultModel, etc.)
 * - Removes escalation/deprecated APIs
 * - quickTierForAgent uses OMB's agent catalog from definitions.ts
 */

import type {
  RoutingContext,
  RoutingDecision,
  RoutingConfig,
  ComplexityTier,
  OmbModelType,
  ReasoningEffort,
} from './types.js';
import {
  DEFAULT_ROUTING_CONFIG,
  TIER_TO_MODEL_TYPE,
  TIER_TO_REASONING,
  getTierModels,
} from './types.js';
import { extractAllSignals } from './signals.js';
import { calculateComplexityScore, calculateConfidence, scoreToTier } from './scorer.js';
import { evaluateRules, DEFAULT_ROUTING_RULES } from './rules.js';
import { getAgent } from '../../agents/definitions.js';

/**
 * Route a task to the appropriate model tier
 */
export function routeTask(
  context: RoutingContext,
  config: Partial<RoutingConfig> = {}
): RoutingDecision {
  const mergedConfig: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG, ...config };

  // If forceInherit is enabled, bypass all routing so agents inherit the parent model
  if (mergedConfig.forceInherit) {
    return {
      model: 'inherit',
      modelType: 'inherit',
      tier: 'MEDIUM',
      reasoningEffort: 'medium',
      confidence: 1.0,
      reasons: ['forceInherit enabled: agents inherit parent model'],
    };
  }

  // If routing is disabled, use default tier
  if (!mergedConfig.enabled) {
    return createDecision(mergedConfig.defaultTier, ['Routing disabled, using default tier']);
  }

  // If explicit model is specified, respect it
  if (context.explicitModel) {
    const explicitTier = modelTypeToTier(context.explicitModel);
    return createDecision(explicitTier, ['Explicit model specified by user']);
  }

  // Check for agent-specific overrides
  if (context.agentType && mergedConfig.agentOverrides?.[context.agentType]) {
    const override = mergedConfig.agentOverrides[context.agentType];
    return createDecision(override.tier, [override.reason]);
  }

  // Extract signals from the task
  const signals = extractAllSignals(context.taskPrompt, context);

  // Evaluate routing rules
  const ruleResult = evaluateRules(context, signals, DEFAULT_ROUTING_RULES);

  if (ruleResult.tier === 'EXPLICIT') {
    return createDecision('MEDIUM', ['Unexpected EXPLICIT tier']);
  }

  // Calculate score for confidence and logging
  const score = calculateComplexityScore(signals);
  const scoreTier = scoreToTier(score);
  let confidence = calculateConfidence(score, ruleResult.tier);

  let finalTier = ruleResult.tier;
  const tierOrder: ComplexityTier[] = ['LOW', 'MEDIUM', 'HIGH'];
  const ruleIdx = tierOrder.indexOf(ruleResult.tier);
  const scoreIdx = tierOrder.indexOf(scoreTier);

  // When scorer and rules diverge by more than 1 level, reduce confidence
  // and prefer the higher tier to avoid under-provisioning
  const divergence = Math.abs(ruleIdx - scoreIdx);
  if (divergence > 1) {
    confidence = Math.min(confidence, 0.5);
    finalTier = tierOrder[Math.max(ruleIdx, scoreIdx)];
  }

  const reasons = [
    ruleResult.reason,
    `Rule: ${ruleResult.ruleName}`,
    `Score: ${score} (${scoreTier} tier by score)`,
    ...(divergence > 1 ? [`Scorer/rules divergence (${divergence} levels): confidence reduced, preferred higher tier`] : []),
  ];

  // Enforce minTier if configured
  if (mergedConfig.minTier) {
    const currentIdx = tierOrder.indexOf(finalTier);
    const minIdx = tierOrder.indexOf(mergedConfig.minTier);
    if (currentIdx < minIdx) {
      finalTier = mergedConfig.minTier;
      reasons.push(`Min tier enforced: ${ruleResult.tier} -> ${finalTier}`);
    }
  }

  // Resolve model and reasoning effort from the final tier
  const tierModels = getTierModels();
  return {
    model: tierModels[finalTier],
    modelType: TIER_TO_MODEL_TYPE[finalTier],
    tier: finalTier,
    reasoningEffort: TIER_TO_REASONING[finalTier],
    confidence,
    reasons,
  };
}

/**
 * Create a routing decision for a given tier
 */
function createDecision(
  tier: ComplexityTier,
  reasons: string[]
): RoutingDecision {
  const tierModels = getTierModels();
  return {
    model: tierModels[tier],
    modelType: TIER_TO_MODEL_TYPE[tier],
    tier,
    reasoningEffort: TIER_TO_REASONING[tier],
    confidence: 0.7,
    reasons,
  };
}

/**
 * Convert OMB ModelType to ComplexityTier
 */
function modelTypeToTier(modelType: OmbModelType): ComplexityTier {
  switch (modelType) {
    case 'frontier':
      return 'HIGH';
    case 'spark':
      return 'LOW';
    case 'standard':
    case 'inherit':
    default:
      return 'MEDIUM';
  }
}

/**
 * Quick tier lookup for known agent types
 * Uses OMB's agent catalog from definitions.ts to derive default tiers.
 *
 * Mapping logic:
 * - modelClass 'fast' -> LOW (spark)
 * - modelClass 'standard' -> MEDIUM (standard)
 * - modelClass 'frontier' -> HIGH (frontier)
 *
 * For cases where the static default doesn't match the agent's complexity,
 * the full routing pipeline with signal analysis should be used instead.
 */
export function quickTierForAgent(agentType: string): ComplexityTier | null {
  const definition = getAgent(agentType);
  if (definition) {
    switch (definition.modelClass) {
      case 'fast':
        return 'LOW';
      case 'frontier':
        return 'HIGH';
      case 'standard':
        return 'MEDIUM';
    }
  }

  // Fallback for agent types not in definitions
  const fallbackTiers: Record<string, ComplexityTier> = {
    'document-specialist': 'MEDIUM',
    'tdd-guide': 'MEDIUM',
  };

  return fallbackTiers[agentType] ?? null;
}

/**
 * Get recommended model for an agent based on task complexity
 *
 * This is the main entry point for orchestrator model routing.
 * The orchestrator calls this to determine which model to use when delegating.
 *
 * ALL agents are adaptive based on task complexity.
 */
export function getModelForTask(
  agentType: string,
  taskPrompt: string,
  config: Partial<RoutingConfig> = {}
): { model: string; modelType: OmbModelType; tier: ComplexityTier; reasoningEffort: ReasoningEffort; reason: string } {
  const decision = routeTask({ taskPrompt, agentType }, config);

  return {
    model: decision.model,
    modelType: decision.modelType,
    tier: decision.tier,
    reasoningEffort: decision.reasoningEffort,
    reason: decision.reasons[0] ?? 'Complexity analysis',
  };
}

/**
 * Generate a complexity analysis summary for the orchestrator
 */
export function analyzeTaskComplexity(
  taskPrompt: string,
  agentType?: string
): {
  tier: ComplexityTier;
  model: string;
  modelType: OmbModelType;
  reasoningEffort: ReasoningEffort;
  analysis: string;
  signals: {
    wordCount: number;
    hasArchitectureKeywords: boolean;
    hasRiskKeywords: boolean;
    estimatedSubtasks: number;
    impactScope: string;
  };
} {
  const signals = extractAllSignals(taskPrompt, { taskPrompt, agentType });
  const decision = routeTask({ taskPrompt, agentType });

  const analysis = [
    `**Tier: ${decision.tier}** -> ${decision.model} (${decision.modelType})`,
    `**Reasoning: ${decision.reasoningEffort}**`,
    '',
    '**Why:**',
    ...decision.reasons.map(r => `- ${r}`),
    '',
    '**Signals detected:**',
    signals.lexical.hasArchitectureKeywords ? '- Architecture keywords (refactor, redesign, etc.)' : null,
    signals.lexical.hasRiskKeywords ? '- Risk keywords (migration, production, critical)' : null,
    signals.lexical.hasDebuggingKeywords ? '- Debugging keywords (root cause, investigate)' : null,
    signals.structural.crossFileDependencies ? '- Cross-file dependencies' : null,
    signals.structural.impactScope === 'system-wide' ? '- System-wide impact' : null,
    signals.structural.reversibility === 'difficult' ? '- Difficult to reverse' : null,
  ].filter(Boolean).join('\n');

  return {
    tier: decision.tier,
    model: decision.model,
    modelType: decision.modelType,
    reasoningEffort: decision.reasoningEffort,
    analysis,
    signals: {
      wordCount: signals.lexical.wordCount,
      hasArchitectureKeywords: signals.lexical.hasArchitectureKeywords,
      hasRiskKeywords: signals.lexical.hasRiskKeywords,
      estimatedSubtasks: signals.structural.estimatedSubtasks,
      impactScope: signals.structural.impactScope,
    },
  };
}

/**
 * Get routing explanation for debugging/logging
 */
export function explainRouting(
  context: RoutingContext,
  config: Partial<RoutingConfig> = {}
): string {
  const decision = routeTask(context, config);
  const signals = extractAllSignals(context.taskPrompt, context);

  const lines = [
    '=== Model Routing Decision ===',
    `Task: ${context.taskPrompt.substring(0, 100)}${context.taskPrompt.length > 100 ? '...' : ''}`,
    `Agent: ${context.agentType ?? 'unspecified'}`,
    '',
    '--- Signals ---',
    `Word count: ${signals.lexical.wordCount}`,
    `File paths: ${signals.lexical.filePathCount}`,
    `Architecture keywords: ${signals.lexical.hasArchitectureKeywords}`,
    `Debugging keywords: ${signals.lexical.hasDebuggingKeywords}`,
    `Simple keywords: ${signals.lexical.hasSimpleKeywords}`,
    `Risk keywords: ${signals.lexical.hasRiskKeywords}`,
    `Question depth: ${signals.lexical.questionDepth}`,
    `Estimated subtasks: ${signals.structural.estimatedSubtasks}`,
    `Cross-file: ${signals.structural.crossFileDependencies}`,
    `Impact scope: ${signals.structural.impactScope}`,
    `Reversibility: ${signals.structural.reversibility}`,
    `Previous failures: ${signals.context.previousFailures}`,
    '',
    '--- Decision ---',
    `Tier: ${decision.tier}`,
    `Model: ${decision.model} (${decision.modelType})`,
    `Reasoning: ${decision.reasoningEffort}`,
    `Confidence: ${decision.confidence}`,
    '',
    '--- Reasons ---',
    ...decision.reasons.map(r => `  - ${r}`),
  ];

  return lines.join('\n');
}
