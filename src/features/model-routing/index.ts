/**
 * Dynamic Model Routing
 *
 * Routes sub-agent tasks to appropriate model tiers (spark/standard/frontier)
 * based on task complexity analysis.
 *
 * Usage:
 *   import { routeTask, getModelForTask, analyzeTaskComplexity } from './model-routing/index.js';
 *
 * Quick routing:
 *   const result = getModelForTask('executor', 'Refactor the authentication module');
 *   // => { model: 'gpt-5.4', modelType: 'frontier', tier: 'HIGH', reasoningEffort: 'high', reason: '...' }
 *
 * Full routing with context:
 *   const decision = routeTask({ taskPrompt, agentType, previousFailures: 1 });
 *
 * Complexity analysis:
 *   const analysis = analyzeTaskComplexity('Fix the database migration issue');
 */

export type {
  ComplexityTier,
  OmbModelType,
  ReasoningEffort,
  LexicalSignals,
  StructuralSignals,
  ContextSignals,
  ComplexitySignals,
  RoutingDecision,
  RoutingContext,
  RoutingRule,
  RoutingConfig,
  PromptAdaptationStrategy,
} from './types.js';

export {
  TIER_TO_MODEL_TYPE,
  TIER_TO_REASONING,
  TIER_PROMPT_STRATEGIES,
  DEFAULT_ROUTING_CONFIG,
  COMPLEXITY_KEYWORDS,
  getTierModels,
} from './types.js';

export {
  extractLexicalSignals,
  extractStructuralSignals,
  extractContextSignals,
  extractAllSignals,
} from './signals.js';

export {
  calculateComplexityScore,
  calculateComplexityTier,
  scoreToTier,
  getScoreBreakdown,
  calculateConfidence,
} from './scorer.js';

export {
  DEFAULT_ROUTING_RULES,
  evaluateRules,
  getMatchingRules,
  createRule,
  mergeRules,
} from './rules.js';

export {
  routeTask,
  quickTierForAgent,
  getModelForTask,
  analyzeTaskComplexity,
  explainRouting,
} from './router.js';
