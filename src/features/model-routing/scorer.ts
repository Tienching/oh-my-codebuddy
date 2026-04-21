/**
 * Complexity Scorer
 *
 * Calculates complexity tier based on extracted signals.
 * Uses weighted scoring to determine LOW/MEDIUM/HIGH tier.
 *
 */

import type {
  ComplexitySignals,
  ComplexityTier,
  LexicalSignals,
  StructuralSignals,
  ContextSignals,
} from './types.js';

/**
 * Score thresholds for tier classification
 */
const TIER_THRESHOLDS = {
  HIGH: 8,    // Score >= 8 -> HIGH (frontier)
  MEDIUM: 4,  // Score >= 4 -> MEDIUM (standard)
  // Score < 4 -> LOW (spark)
};

/**
 * Weight configuration for different signal categories
 */
const WEIGHTS = {
  lexical: {
    wordCountHigh: 2,
    wordCountVeryHigh: 1,
    filePathsMultiple: 1,
    codeBlocksPresent: 1,
    architectureKeywords: 3,
    debuggingKeywords: 2,
    simpleKeywords: -2,
    riskKeywords: 2,
    questionDepthWhy: 2,
    questionDepthHow: 1,
    implicitRequirements: 1,
  },
  structural: {
    subtasksMany: 3,
    subtasksSome: 1,
    crossFile: 2,
    testRequired: 1,
    securityDomain: 2,
    infrastructureDomain: 1,
    externalKnowledge: 1,
    reversibilityDifficult: 2,
    reversibilityModerate: 1,
    impactSystemWide: 3,
    impactModule: 1,
  },
  context: {
    previousFailure: 2,
    previousFailureMax: 4,
    deepChain: 2,
    complexPlan: 1,
  },
};

/**
 * Calculate complexity score from lexical signals
 */
function scoreLexicalSignals(signals: LexicalSignals): number {
  let score = 0;

  if (signals.wordCount > 200) {
    score += WEIGHTS.lexical.wordCountHigh;
    if (signals.wordCount > 500) {
      score += WEIGHTS.lexical.wordCountVeryHigh;
    }
  }

  if (signals.filePathCount >= 2) {
    score += WEIGHTS.lexical.filePathsMultiple;
  }

  if (signals.codeBlockCount > 0) {
    score += WEIGHTS.lexical.codeBlocksPresent;
  }

  if (signals.hasArchitectureKeywords) {
    score += WEIGHTS.lexical.architectureKeywords;
  }
  if (signals.hasDebuggingKeywords) {
    score += WEIGHTS.lexical.debuggingKeywords;
  }
  if (signals.hasSimpleKeywords) {
    score += WEIGHTS.lexical.simpleKeywords;
  }
  if (signals.hasRiskKeywords) {
    score += WEIGHTS.lexical.riskKeywords;
  }

  switch (signals.questionDepth) {
    case 'why':
      score += WEIGHTS.lexical.questionDepthWhy;
      break;
    case 'how':
      score += WEIGHTS.lexical.questionDepthHow;
      break;
  }

  if (signals.hasImplicitRequirements) {
    score += WEIGHTS.lexical.implicitRequirements;
  }

  return score;
}

/**
 * Calculate complexity score from structural signals
 */
function scoreStructuralSignals(signals: StructuralSignals): number {
  let score = 0;

  if (signals.estimatedSubtasks > 3) {
    score += WEIGHTS.structural.subtasksMany;
  } else if (signals.estimatedSubtasks > 1) {
    score += WEIGHTS.structural.subtasksSome;
  }

  if (signals.crossFileDependencies) {
    score += WEIGHTS.structural.crossFile;
  }

  if (signals.hasTestRequirements) {
    score += WEIGHTS.structural.testRequired;
  }

  switch (signals.domainSpecificity) {
    case 'security':
      score += WEIGHTS.structural.securityDomain;
      break;
    case 'infrastructure':
      score += WEIGHTS.structural.infrastructureDomain;
      break;
  }

  if (signals.requiresExternalKnowledge) {
    score += WEIGHTS.structural.externalKnowledge;
  }

  switch (signals.reversibility) {
    case 'difficult':
      score += WEIGHTS.structural.reversibilityDifficult;
      break;
    case 'moderate':
      score += WEIGHTS.structural.reversibilityModerate;
      break;
  }

  switch (signals.impactScope) {
    case 'system-wide':
      score += WEIGHTS.structural.impactSystemWide;
      break;
    case 'module':
      score += WEIGHTS.structural.impactModule;
      break;
  }

  return score;
}

/**
 * Calculate complexity score from context signals
 */
function scoreContextSignals(signals: ContextSignals): number {
  let score = 0;

  const failureScore = Math.min(
    signals.previousFailures * WEIGHTS.context.previousFailure,
    WEIGHTS.context.previousFailureMax
  );
  score += failureScore;

  if (signals.agentChainDepth >= 3) {
    score += WEIGHTS.context.deepChain;
  }

  if (signals.planComplexity >= 5) {
    score += WEIGHTS.context.complexPlan;
  }

  return score;
}

/**
 * Calculate total complexity score
 */
export function calculateComplexityScore(signals: ComplexitySignals): number {
  const lexicalScore = scoreLexicalSignals(signals.lexical);
  const structuralScore = scoreStructuralSignals(signals.structural);
  const contextScore = scoreContextSignals(signals.context);

  return lexicalScore + structuralScore + contextScore;
}

/**
 * Determine complexity tier from score
 */
export function scoreToTier(score: number): ComplexityTier {
  if (score >= TIER_THRESHOLDS.HIGH) return 'HIGH';
  if (score >= TIER_THRESHOLDS.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/**
 * Calculate complexity tier from signals
 */
export function calculateComplexityTier(signals: ComplexitySignals): ComplexityTier {
  const score = calculateComplexityScore(signals);
  return scoreToTier(score);
}

/**
 * Get detailed score breakdown for debugging/logging
 */
export function getScoreBreakdown(signals: ComplexitySignals): {
  lexical: number;
  structural: number;
  context: number;
  total: number;
  tier: ComplexityTier;
} {
  const lexical = scoreLexicalSignals(signals.lexical);
  const structural = scoreStructuralSignals(signals.structural);
  const context = scoreContextSignals(signals.context);
  const total = lexical + structural + context;

  return {
    lexical,
    structural,
    context,
    total,
    tier: scoreToTier(total),
  };
}

/**
 * Calculate confidence in the tier assignment
 * Higher confidence when score is far from thresholds
 */
export function calculateConfidence(score: number, tier: ComplexityTier): number {
  const distanceFromLow = Math.abs(score - TIER_THRESHOLDS.MEDIUM);
  const distanceFromHigh = Math.abs(score - TIER_THRESHOLDS.HIGH);

  let minDistance: number;
  switch (tier) {
    case 'LOW':
      minDistance = TIER_THRESHOLDS.MEDIUM - score;
      break;
    case 'MEDIUM':
      minDistance = Math.min(distanceFromLow, distanceFromHigh);
      break;
    case 'HIGH':
      minDistance = score - TIER_THRESHOLDS.HIGH;
      break;
  }

  // Distance of 0 = 0.5 confidence, distance of 4+ = 0.9+ confidence
  const confidence = 0.5 + (Math.min(minDistance, 4) / 4) * 0.4;
  return Math.round(confidence * 100) / 100;
}
