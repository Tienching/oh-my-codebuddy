import {
  buildTeamExecutionPlan,
  decomposeTaskString,
  type TeamExecutionPlan,
} from '../../cli/team.js';
import {
  OMB_MAGIC_KEYWORD_ROUTER_ENV,
  OMX_MAGIC_KEYWORD_ROUTER_ENV,
  isExperimentalMagicKeywordRouterEnabled,
} from '../magic-keywords.js';
import type {
  TaskDecomposerOptions,
  TaskDecompositionPlan,
  TaskDecompositionTask,
} from './types.js';

export type {
  TaskDecomposerOptions,
  TaskDecompositionMetadata,
  TaskDecompositionPlan,
  TaskDecompositionStrategy,
  TaskDecompositionTask,
} from './types.js';

export {
  OMB_MAGIC_KEYWORD_ROUTER_ENV,
  OMX_MAGIC_KEYWORD_ROUTER_ENV,
  isExperimentalMagicKeywordRouterEnabled,
};

function normalizePlan(plan: TeamExecutionPlan): TaskDecompositionPlan {
  return {
    workerCount: plan.workerCount,
    tasks: plan.tasks as TaskDecompositionTask[],
    metadata: plan.metadata,
  };
}

export function buildTaskDecompositionPlan(
  task: string,
  options: TaskDecomposerOptions,
): TaskDecompositionPlan {
  return normalizePlan(buildTeamExecutionPlan(
    task,
    options.workerCount,
    options.agentType,
    options.explicitAgentType,
    options.explicitWorkerCount ?? false,
  ));
}

export function decomposeTask(
  task: string,
  options: TaskDecomposerOptions,
): TaskDecompositionTask[] {
  return decomposeTaskString(
    task,
    options.workerCount,
    options.agentType,
    options.explicitAgentType,
    options.explicitWorkerCount ?? false,
  ) as TaskDecompositionTask[];
}
