import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDelegationRoutingPlan, evaluateDelegationEnforcement } from '../delegation-routing/index.js';
import { buildTaskDecompositionPlan } from '../task-decomposer/index.js';

describe('delegation-routing', () => {
  it('rejects routing while the feature flag is disabled', () => {
    const plan = buildDelegationRoutingPlan('fix tests, build UI, and write docs', {
      workerCount: 3,
      agentType: 'executor',
      explicitAgentType: false,
      env: {},
    });

    assert.equal(plan.enabled, false);
    assert.equal(plan.enforcement.allowed, false);
    assert.equal(plan.enforcement.code, 'feature_flag_disabled');
  });

  it('rejects tasks that explicitly forbid delegation', () => {
    const decomposition = buildTaskDecompositionPlan('do not delegate this fix; keep it single-lane', {
      workerCount: 3,
      agentType: 'executor',
      explicitAgentType: false,
    });
    const decision = evaluateDelegationEnforcement('do not delegate this fix; keep it single-lane', decomposition, {
      env: { OMB_MAGIC_KEYWORD_ROUTER: '1' } as NodeJS.ProcessEnv,
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.code, 'delegation_disabled');
  });

  it('allows flagged multi-lane routing and preserves decomposition metadata', () => {
    const plan = buildDelegationRoutingPlan('fix tests, build UI component, and write documentation', {
      workerCount: 3,
      agentType: 'executor',
      explicitAgentType: false,
      env: { OMB_MAGIC_KEYWORD_ROUTER: '1' } as NodeJS.ProcessEnv,
    });

    assert.equal(plan.enabled, true);
    assert.equal(plan.enforcement.allowed, true);
    assert.equal(plan.decomposition.metadata.strategy, 'conjunction');
    assert.ok(plan.decomposition.tasks.some((task) => task.role === 'writer'));
    assert.ok(plan.decomposition.tasks.some((task) => task.role === 'designer' || task.role === 'test-engineer'));
  });
});
