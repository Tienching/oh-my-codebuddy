import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type TaskFlag = {
  name: string;
  default: boolean;
  owner: string;
};

type TaskRollback = {
  owner: string;
  steps: string[];
};

type PlanTask = {
  id: string;
  pass?: boolean;
  priority?: string;
  dependencies?: string[];
  feature_flags?: TaskFlag[];
  rollback?: TaskRollback;
  subtasks?: Array<{
    id: string;
    pass?: boolean;
  }>;
};

type MigrationPlan = {
  analysis_snapshot?: {
    shared_top_dirs?: string[];
  };
  migration_categories?: Array<{ id: string }>;
  migration_module_matrix?: Array<{ source_module: string; classification: string }>;
  conflict_matrix?: Array<{ surface: string }>;
  milestones?: Array<{ id: string; acceptance: string[] }>;
  dependency_topology?: string[];
  tasks: PlanTask[];
};

function repoRoot(): string {
  return join(process.cwd());
}

function readPlan(): MigrationPlan {
  const path = join(repoRoot(), 'task.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as MigrationPlan;
}

function mustExist(path: string): void {
  assert.equal(existsSync(path), true, `missing required artifact: ${path}`);
}

describe('migration baseline release gate artifacts', () => {
  it('requires contract and QA docs with the baseline sections', () => {
    const root = repoRoot();
    const contractPath = join(root, 'docs', 'contracts', 'migration-baseline.md');
    const qaPath = join(root, 'docs', 'qa', 'migration-shadow-gates.md');
    mustExist(contractPath);
    mustExist(qaPath);

    const contract = readFileSync(contractPath, 'utf-8');
    const qa = readFileSync(qaPath, 'utf-8');

    for (const heading of [
      '## Migration categories',
      '## Module migration matrix',
      '## Conflict matrix',
      '## Milestones',
      '## Dependency topology',
      '## Migration fixture inventory',
      '## Feature-flag registry baseline',
    ]) {
      assert.match(contract, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    for (const gate of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) {
      assert.match(qa, new RegExp(`\\|\\s*${gate}\\s*\\|`));
    }
    assert.match(qa, /Pass-by-default safeguards/);
    assert.match(qa, /Shadow diff report template/);
    assert.match(qa, /Rollback runbook template/);
  });

  it('requires task.json to freeze categories, module coverage, conflicts, milestones, and an acyclic topology', () => {
    const plan = readPlan();

    assert.deepEqual(
      plan.migration_categories?.map((entry) => entry.id),
      ['direct-port', 'adapter-first', 'reference-only'],
    );

    const mappedModules = new Set((plan.migration_module_matrix ?? []).map((entry) => entry.source_module));
    for (const moduleName of plan.analysis_snapshot?.shared_top_dirs ?? []) {
      assert.equal(mappedModules.has(moduleName), true, `missing module mapping for ${moduleName}`);
    }

    assert.deepEqual(
      (plan.conflict_matrix ?? []).map((entry) => entry.surface),
      ['CLI', 'Paths', 'Hooks', 'State'],
    );

    assert.equal((plan.milestones ?? []).length >= 3, true);
    for (const milestone of plan.milestones ?? []) {
      assert.equal(Array.isArray(milestone.acceptance), true);
      assert.equal(milestone.acceptance.length > 0, true, `milestone ${milestone.id} needs acceptance`);
    }

    const topology = plan.dependency_topology ?? [];
    const order = new Map(topology.map((taskId, index) => [taskId, index]));
    assert.equal(topology.length > 0, true, 'dependency_topology must not be empty');
    for (const task of plan.tasks) {
      if (!order.has(task.id)) continue;
      const taskIndex = order.get(task.id)!;
      for (const dependency of task.dependencies ?? []) {
        assert.equal(order.has(dependency), true, `missing dependency ${dependency} from topology`);
        assert.equal(order.get(dependency)! < taskIndex, true, `${task.id} appears before dependency ${dependency}`);
      }
    }
  });

  it('requires every P0/P1 task to declare feature flags and rollback ownership', () => {
    const plan = readPlan();
    const guardedTasks = plan.tasks.filter((task) => task.priority === 'P0' || task.priority === 'P1');
    assert.equal(guardedTasks.length > 0, true);

    for (const task of guardedTasks) {
      const flags = task.feature_flags ?? [];
      assert.equal(flags.length > 0, true, `${task.id} missing feature_flags`);
      for (const flag of flags) {
        assert.equal(typeof flag.name, 'string');
        assert.equal(flag.name.startsWith('OMB_'), true, `${task.id} flag must start with OMB_`);
        assert.equal(typeof flag.default, 'boolean');
        assert.equal(typeof flag.owner, 'string');
        assert.equal(flag.owner.trim().length > 0, true, `${task.id} flag owner missing`);
      }

      const rollback = task.rollback;
      assert.ok(rollback, `${task.id} missing rollback`);
      assert.equal(typeof rollback?.owner, 'string');
      assert.equal((rollback?.owner ?? '').trim().length > 0, true, `${task.id} rollback owner missing`);
      assert.equal(Array.isArray(rollback?.steps), true, `${task.id} rollback steps missing`);
      assert.equal((rollback?.steps ?? []).length > 0, true, `${task.id} rollback steps empty`);
    }
  });

  it('requires every migration task and subtask to stay accepted in task.json', () => {
    const plan = readPlan();
    assert.equal(plan.tasks.length > 0, true, 'task.json must contain migration tasks');

    for (const task of plan.tasks) {
      assert.equal(task.pass, true, `${task.id} must remain accepted before release`);
      for (const subtask of task.subtasks ?? []) {
        assert.equal(subtask.pass, true, `${subtask.id} must remain accepted before release`);
      }
    }
  });
});
