import {
  evaluateDelegationEnforcement,
  isExperimentalMagicKeywordRouterEnabled,
  OMB_MAGIC_KEYWORD_ROUTER_ENV,
  type DelegationEnforcementDecision,
  type DelegationEnforcementOptions,
} from '../delegation-enforcer.js';
import {
  buildTaskDecompositionPlan,
  type TaskDecomposerOptions,
  type TaskDecompositionPlan,
} from '../task-decomposer/index.js';

export interface DelegationRoutingPlan {
  enabled: boolean;
  featureFlag: typeof OMB_MAGIC_KEYWORD_ROUTER_ENV;
  fallbackFeatureFlag: typeof OMB_MAGIC_KEYWORD_ROUTER_ENV;
  decomposition: TaskDecompositionPlan;
  enforcement: DelegationEnforcementDecision;
}

export {
  buildTaskDecompositionPlan,
  evaluateDelegationEnforcement,
  isExperimentalMagicKeywordRouterEnabled,
  OMB_MAGIC_KEYWORD_ROUTER_ENV,
};

export function buildDelegationRoutingPlan(
  task: string,
  options: TaskDecomposerOptions & DelegationEnforcementOptions,
): DelegationRoutingPlan {
  const decomposition = buildTaskDecompositionPlan(task, options);
  return {
    enabled: isExperimentalMagicKeywordRouterEnabled(options.env),
    featureFlag: OMB_MAGIC_KEYWORD_ROUTER_ENV,
    fallbackFeatureFlag: OMB_MAGIC_KEYWORD_ROUTER_ENV,
    decomposition,
    enforcement: evaluateDelegationEnforcement(task, decomposition, options),
  };
}
