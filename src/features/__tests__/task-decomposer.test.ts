import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskDecompositionPlan, decomposeTask } from '../task-decomposer/index.js';

describe('task-decomposer', () => {
  it('exposes numbered-list decomposition metadata from the team CLI planner', () => {
    const plan = buildTaskDecompositionPlan('1. add auth 2. write tests 3. update docs', {
      workerCount: 3,
      agentType: 'executor',
      explicitAgentType: false,
    });

    assert.equal(plan.workerCount, 3);
    assert.equal(plan.metadata.strategy, 'numbered');
    assert.equal(plan.metadata.usedAspectSubtasks, false);
    assert.equal(plan.metadata.fallbackRole, 'team-executor');
    assert.equal(plan.tasks.length, 3);
  });

  it('preserves route metadata for mixed-role decomposition', () => {
    const plan = buildTaskDecompositionPlan('fix tests, build UI component, and write documentation', {
      workerCount: 3,
      agentType: 'executor',
      explicitAgentType: false,
    });

    const routeReasons = plan.tasks.map((task) => task.route_reason ?? '');
    const routeConfidence = new Set(plan.tasks.map((task) => task.route_confidence));
    const roles = new Set(plan.tasks.map((task) => task.role));

    assert.equal(routeReasons.every((reason) => reason.length > 0), true);
    assert.ok(routeConfidence.has('high'));
    assert.ok(roles.size >= 2);
  });

  it('falls back to aspect subtasks with metadata for explicit atomic fanout', () => {
    const plan = buildTaskDecompositionPlan('implement user login', {
      workerCount: 3,
      agentType: 'executor',
      explicitAgentType: false,
      explicitWorkerCount: true,
    });

    assert.equal(plan.metadata.strategy, 'atomic');
    assert.equal(plan.metadata.usedAspectSubtasks, true);
    assert.equal(plan.tasks.length, 3);
    assert.match(plan.tasks[0].subject, /^Implement:/i);
  });

  it('retains the existing task list shape for direct decomposition consumers', () => {
    const tasks = decomposeTask('fix tests, build UI, and write docs', {
      workerCount: 3,
      agentType: 'executor',
      explicitAgentType: false,
    });

    assert.equal(tasks.length, 3);
    assert.deepEqual(tasks.map((task) => task.owner), ['worker-1', 'worker-2', 'worker-3']);
  });
});
