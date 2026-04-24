import {
  isExperimentalMagicKeywordRouterEnabled,
  OMB_MAGIC_KEYWORD_ROUTER_ENV,
} from './magic-keywords.js';
import type { TaskDecompositionPlan } from './task-decomposer/types.js';

export type DelegationEnforcementCode =
  | 'allowed'
  | 'blank_task'
  | 'feature_flag_disabled'
  | 'delegation_disabled'
  | 'single_lane_only';

export interface DelegationEnforcementDecision {
  allowed: boolean;
  code: DelegationEnforcementCode;
  reason: string;
}

export interface DelegationEnforcementOptions {
  env?: NodeJS.ProcessEnv;
  requireFeatureFlag?: boolean;
}

const DELEGATION_DISABLE_PATTERNS = [
  /\b(?:do not|don't|dont)\s+(?:delegate|parallelize|fan out)\b/i,
  /\b(?:single[ -]?lane|single[ -]?thread(?:ed)?|no\s+parallel(?:ism|ization)?)\b/i,
];

export {
  OMB_MAGIC_KEYWORD_ROUTER_ENV,
  isExperimentalMagicKeywordRouterEnabled,
};

export function evaluateDelegationEnforcement(
  task: string,
  plan: TaskDecompositionPlan,
  options: DelegationEnforcementOptions = {},
): DelegationEnforcementDecision {
  const normalizedTask = task.trim();
  if (!normalizedTask) {
    return {
      allowed: false,
      code: 'blank_task',
      reason: 'cannot route delegation for an empty task',
    };
  }

  if (options.requireFeatureFlag !== false && !isExperimentalMagicKeywordRouterEnabled(options.env)) {
    return {
      allowed: false,
      code: 'feature_flag_disabled',
      reason: `delegation routing is disabled until ${OMB_MAGIC_KEYWORD_ROUTER_ENV}=1 (or ${OMB_MAGIC_KEYWORD_ROUTER_ENV}=1)`,
    };
  }

  if (DELEGATION_DISABLE_PATTERNS.some((pattern) => pattern.test(normalizedTask))) {
    return {
      allowed: false,
      code: 'delegation_disabled',
      reason: 'task explicitly requests a single-lane / no-delegation execution path',
    };
  }

  if (plan.workerCount <= 1 || plan.tasks.length <= 1) {
    return {
      allowed: false,
      code: 'single_lane_only',
      reason: 'current decomposition resolves to a single worker lane, so delegation would not add value',
    };
  }

  return {
    allowed: true,
    code: 'allowed',
    reason: 'task can be delegated with the current decomposition and routing plan',
  };
}
