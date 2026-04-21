import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLexicalSignals,
  extractStructuralSignals,
  extractContextSignals,
  extractAllSignals,
} from '../signals.js';
import {
  calculateComplexityScore,
  calculateComplexityTier,
  scoreToTier,
  getScoreBreakdown,
  calculateConfidence,
} from '../scorer.js';
import {
  evaluateRules,
  getMatchingRules,
  createRule,
  mergeRules,
} from '../rules.js';
import {
  routeTask,
  quickTierForAgent,
  getModelForTask,
  analyzeTaskComplexity,
} from '../router.js';
import type { ComplexityTier, RoutingContext } from '../types.js';
import { TIER_TO_MODEL_TYPE, TIER_TO_REASONING, getTierModels } from '../types.js';

// ============ Signals Tests ============

describe('model-routing: signals', () => {
  it('extracts lexical signals from a simple prompt', () => {
    const signals = extractLexicalSignals('find the main entry point');
    assert.ok(signals.wordCount > 0);
    assert.equal(signals.hasSimpleKeywords, true);
    assert.equal(signals.hasArchitectureKeywords, false);
    assert.equal(signals.hasRiskKeywords, false);
  });

  it('detects architecture keywords', () => {
    const signals = extractLexicalSignals('Refactor the authentication module to decouple services');
    assert.equal(signals.hasArchitectureKeywords, true);
  });

  it('detects debugging keywords', () => {
    const signals = extractLexicalSignals('Debug the root cause of the memory leak');
    assert.equal(signals.hasDebuggingKeywords, true);
  });

  it('detects risk keywords', () => {
    const signals = extractLexicalSignals('Deploy to production urgently - critical security fix');
    assert.equal(signals.hasRiskKeywords, true);
  });

  it('detects question depth', () => {
    const why = extractLexicalSignals('Why is the build failing?');
    assert.equal(why.questionDepth, 'why');

    const how = extractLexicalSignals('How does this work?');
    assert.equal(how.questionDepth, 'how');

    const what = extractLexicalSignals('What is this function?');
    assert.equal(what.questionDepth, 'what');
  });

  it('counts file paths', () => {
    const signals = extractLexicalSignals('Edit src/config/models.ts and src/team/runtime.ts');
    assert.ok(signals.filePathCount >= 2);
  });

  it('counts code blocks', () => {
    const prompt = 'Fix this code:\n```ts\nconst x = 1;\n```\nAnd also:\n```ts\nconst y = 2;\n```';
    const signals = extractLexicalSignals(prompt);
    assert.equal(signals.codeBlockCount, 2);
  });

  it('detects implicit requirements', () => {
    const signals = extractLexicalSignals('improve the code');
    assert.equal(signals.hasImplicitRequirements, true);
  });

  it('extracts structural signals', () => {
    const signals = extractStructuralSignals('Refactor all files in the project - this is a system-wide migration');
    assert.equal(signals.impactScope, 'system-wide');
    assert.equal(signals.reversibility, 'difficult');
  });

  it('detects security domain', () => {
    // Use a prompt where "auth" doesn't appear and "security" clearly does
    const signals = extractStructuralSignals('Implement proper CSRF protection for the session management');
    assert.equal(signals.domainSpecificity, 'security');
  });

  it('detects frontend domain', () => {
    const signals = extractStructuralSignals('Build a new React component with Tailwind CSS');
    assert.equal(signals.domainSpecificity, 'frontend');
  });

  it('detects test requirements', () => {
    const signals = extractStructuralSignals('Write unit tests for the new module');
    assert.equal(signals.hasTestRequirements, true);
  });

  it('detects cross-file dependencies', () => {
    const signals = extractStructuralSignals('Changes span multiple files across the entire project');
    assert.equal(signals.crossFileDependencies, true);
  });

  it('extracts context signals', () => {
    const ctx: RoutingContext = {
      taskPrompt: 'test',
      previousFailures: 2,
      conversationTurns: 5,
      planTasks: 8,
      remainingTasks: 3,
      agentChainDepth: 4,
    };
    const signals = extractContextSignals(ctx);
    assert.equal(signals.previousFailures, 2);
    assert.equal(signals.conversationTurns, 5);
    assert.equal(signals.planComplexity, 8);
  });

  it('extracts all signals combined', () => {
    const ctx: RoutingContext = { taskPrompt: 'Refactor the auth module', previousFailures: 1 };
    const signals = extractAllSignals('Refactor the auth module', ctx);
    assert.ok(signals.lexical.wordCount > 0);
    assert.ok(signals.structural.estimatedSubtasks >= 1);
    assert.equal(signals.context.previousFailures, 1);
  });
});

// ============ Scorer Tests ============

describe('model-routing: scorer', () => {
  it('LOW tier for simple prompts', () => {
    const tier = calculateComplexityTier(
      extractAllSignals('find the file', { taskPrompt: 'find the file' })
    );
    assert.equal(tier, 'LOW');
  });

  it('HIGH tier for complex architecture prompts', () => {
    const tier = calculateComplexityTier(
      extractAllSignals(
        'Refactor the entire authentication architecture to decouple all services. This is a critical production migration that affects the whole system. Investigate root cause of the security vulnerability.',
        { taskPrompt: 'Refactor the entire authentication architecture...' }
      )
    );
    assert.equal(tier, 'HIGH');
  });

  it('scoreToTier maps correctly', () => {
    assert.equal(scoreToTier(0), 'LOW');
    assert.equal(scoreToTier(3), 'LOW');
    assert.equal(scoreToTier(4), 'MEDIUM');
    assert.equal(scoreToTier(7), 'MEDIUM');
    assert.equal(scoreToTier(8), 'HIGH');
    assert.equal(scoreToTier(15), 'HIGH');
  });

  it('getScoreBreakdown returns all components', () => {
    const signals = extractAllSignals('Fix the bug', { taskPrompt: 'Fix the bug' });
    const breakdown = getScoreBreakdown(signals);
    assert.ok(typeof breakdown.lexical === 'number');
    assert.ok(typeof breakdown.structural === 'number');
    assert.ok(typeof breakdown.context === 'number');
    assert.equal(breakdown.total, breakdown.lexical + breakdown.structural + breakdown.context);
    assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(breakdown.tier));
  });

  it('calculateConfidence is higher for clear-cut scores', () => {
    const lowConf = calculateConfidence(4, 'MEDIUM');   // right at boundary
    const highConf = calculateConfidence(12, 'HIGH');    // far from boundary
    assert.ok(highConf > lowConf);
  });

  it('previous failures boost score', () => {
    const noFailures = calculateComplexityScore(
      extractAllSignals('Fix the bug', { taskPrompt: 'Fix the bug', previousFailures: 0 })
    );
    const withFailures = calculateComplexityScore(
      extractAllSignals('Fix the bug', { taskPrompt: 'Fix the bug', previousFailures: 3 })
    );
    assert.ok(withFailures > noFailures);
  });
});

// ============ Rules Tests ============

describe('model-routing: rules', () => {
  it('evaluates default-medium as fallback', () => {
    const result = evaluateRules(
      { taskPrompt: 'do something' },
      extractAllSignals('do something', { taskPrompt: 'do something' })
    );
    assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(result.tier as ComplexityTier));
    assert.ok(result.ruleName.length > 0);
  });

  it('architect with architecture keywords routes HIGH', () => {
    const result = evaluateRules(
      { taskPrompt: 'design the architecture', agentType: 'architect' },
      extractAllSignals('design the architecture', { taskPrompt: 'design the architecture', agentType: 'architect' })
    );
    assert.equal(result.tier, 'HIGH');
    assert.equal(result.ruleName, 'architect-complex-debugging');
  });

  it('simple search routes LOW', () => {
    const result = evaluateRules(
      { taskPrompt: 'find where the config is' },
      extractAllSignals('find where the config is', { taskPrompt: 'find where the config is' })
    );
    assert.equal(result.tier, 'LOW');
  });

  it('security domain routes HIGH', () => {
    const result = evaluateRules(
      { taskPrompt: 'Fix the XSS vulnerability' },
      extractAllSignals('Fix the XSS vulnerability', { taskPrompt: 'Fix the XSS vulnerability' })
    );
    assert.equal(result.tier, 'HIGH');
    assert.equal(result.ruleName, 'security-domain');
  });

  it('createRule works', () => {
    const rule = createRule(
      'test-rule',
      () => true,
      'HIGH',
      'Test reason',
      200
    );
    assert.equal(rule.name, 'test-rule');
    assert.equal(rule.action.tier, 'HIGH');
    assert.equal(rule.priority, 200);
  });

  it('mergeRules deduplicates by name', () => {
    const custom = createRule('security-domain', () => false, 'LOW', 'Override', 99);
    const merged = mergeRules([custom]);
    const securityRules = merged.filter(r => r.name === 'security-domain');
    assert.equal(securityRules.length, 1);
    assert.equal(securityRules[0].action.tier, 'LOW');
  });

  it('getMatchingRules returns all matching rules', () => {
    const ctx: RoutingContext = { taskPrompt: 'find the file' };
    const signals = extractAllSignals('find the file', ctx);
    const matches = getMatchingRules(ctx, signals);
    assert.ok(matches.length >= 1);
  });
});

// ============ Router Tests ============

describe('model-routing: router', () => {
  it('returns inherit when forceInherit is true', () => {
    const decision = routeTask(
      { taskPrompt: 'complex task' },
      { forceInherit: true }
    );
    assert.equal(decision.modelType, 'inherit');
    assert.equal(decision.model, 'inherit');
  });

  it('returns default tier when routing is disabled', () => {
    const decision = routeTask(
      { taskPrompt: 'complex task' },
      { enabled: false, defaultTier: 'MEDIUM' }
    );
    assert.equal(decision.tier, 'MEDIUM');
  });

  it('respects explicit model override', () => {
    const decision = routeTask(
      { taskPrompt: 'simple task', explicitModel: 'frontier' }
    );
    assert.equal(decision.tier, 'HIGH');
    assert.equal(decision.modelType, 'frontier');
  });

  it('respects agent-specific overrides', () => {
    const decision = routeTask(
      { taskPrompt: 'simple task', agentType: 'custom-agent' },
      { agentOverrides: { 'custom-agent': { tier: 'HIGH', reason: 'Always HIGH' } } }
    );
    assert.equal(decision.tier, 'HIGH');
  });

  it('routes simple search to spark/LOW', () => {
    const decision = routeTask({ taskPrompt: 'find where the config is' });
    assert.equal(decision.tier, 'LOW');
    assert.equal(decision.modelType, 'spark');
    assert.equal(decision.reasoningEffort, 'low');
  });

  it('routes architecture refactor to frontier/HIGH', () => {
    const decision = routeTask({ taskPrompt: 'Refactor the entire authentication architecture to decouple all services. This is a critical production migration.' });
    assert.equal(decision.tier, 'HIGH');
    assert.equal(decision.modelType, 'frontier');
    assert.equal(decision.reasoningEffort, 'high');
  });

  it('includes reasoningEffort in all decisions', () => {
    const decision = routeTask({ taskPrompt: 'test' });
    assert.ok(['low', 'medium', 'high'].includes(decision.reasoningEffort));
  });

  it('enforces minTier', () => {
    const decision = routeTask(
      { taskPrompt: 'find the file' },
      { minTier: 'MEDIUM' }
    );
    assert.ok(['MEDIUM', 'HIGH'].includes(decision.tier));
  });

  it('quickTierForAgent returns correct tier from definitions', () => {
    assert.equal(quickTierForAgent('explore'), 'LOW');
    assert.equal(quickTierForAgent('executor'), 'MEDIUM');
    assert.equal(quickTierForAgent('architect'), 'HIGH');
    assert.equal(quickTierForAgent('critic'), 'HIGH');
    assert.equal(quickTierForAgent('style-reviewer'), 'LOW');
    assert.equal(quickTierForAgent('unknown-agent'), null);
  });

  it('getModelForTask returns complete routing info', () => {
    const result = getModelForTask('executor', 'Fix the bug in the config module');
    assert.ok(result.model.length > 0);
    assert.ok(['spark', 'standard', 'frontier'].includes(result.modelType));
    assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(result.tier));
    assert.ok(['low', 'medium', 'high'].includes(result.reasoningEffort));
    assert.ok(result.reason.length > 0);
  });

  it('analyzeTaskComplexity returns full analysis', () => {
    const analysis = analyzeTaskComplexity('Refactor the security module');
    assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(analysis.tier));
    assert.ok(analysis.model.length > 0);
    assert.ok(analysis.analysis.length > 0);
    assert.ok(typeof analysis.signals.wordCount === 'number');
  });

  it('TIER_TO_MODEL_TYPE maps correctly', () => {
    assert.equal(TIER_TO_MODEL_TYPE.LOW, 'spark');
    assert.equal(TIER_TO_MODEL_TYPE.MEDIUM, 'standard');
    assert.equal(TIER_TO_MODEL_TYPE.HIGH, 'frontier');
  });

  it('TIER_TO_REASONING maps correctly', () => {
    assert.equal(TIER_TO_REASONING.LOW, 'low');
    assert.equal(TIER_TO_REASONING.MEDIUM, 'medium');
    assert.equal(TIER_TO_REASONING.HIGH, 'high');
  });

  it('getTierModels resolves model IDs', () => {
    const models = getTierModels();
    assert.ok(models.LOW.length > 0);
    assert.ok(models.MEDIUM.length > 0);
    assert.ok(models.HIGH.length > 0);
    // Ensure they're different tiers
    assert.notEqual(models.LOW, models.HIGH);
  });
});
