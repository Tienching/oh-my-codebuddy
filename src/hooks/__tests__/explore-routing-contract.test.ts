import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPLORE_ROUTING_RULES,
  classifyTaskKind,
  matchRoutingRule,
  resolveExploreSurface,
  isSimpleExplorationPrompt,
} from '../explore-routing-rules.js';

describe('explore-routing-contract', () => {
  // ── Rules table integrity ───────────────────────────────────────────

  it('every rule has a unique id and taskKind', () => {
    const ids = new Set(EXPLORE_ROUTING_RULES.map((r) => r.id));
    const kinds = new Set(EXPLORE_ROUTING_RULES.map((r) => r.taskKind));
    assert.equal(ids.size, EXPLORE_ROUTING_RULES.length, 'duplicate rule ids');
    assert.equal(kinds.size, EXPLORE_ROUTING_RULES.length, 'duplicate taskKinds');
  });

  it('every rule has valid surface values', () => {
    const validSurfaces = new Set(['omb-explore', 'normal-path']);
    for (const rule of EXPLORE_ROUTING_RULES) {
      assert.equal(validSurfaces.has(rule.preferredSurface), true, `${rule.id} preferredSurface`);
      assert.equal(validSurfaces.has(rule.fallbackSurface), true, `${rule.id} fallbackSurface`);
    }
  });

  // ── Table-driven routing tests ──────────────────────────────────────

  const routingCases: Array<{
    description: string;
    expectedKind: string;
    expectedSurface: 'omb-explore' | 'normal-path';
    expectedRuleId: string;
  }> = [
    // Symbol lookup → omb-explore
    {
      description: 'find the definition of RuntimeBridge',
      expectedKind: 'symbol_lookup',
      expectedSurface: 'omb-explore',
      expectedRuleId: 'symbol-lookup',
    },
    {
      description: 'where is resolveCanonicalTeamStateRoot',
      expectedKind: 'read_only_search',
      expectedSurface: 'omb-explore',
      expectedRuleId: 'read-only-grep',
    },
    {
      description: 'show symbol references for normalizeCmdline',
      expectedKind: 'symbol_lookup',
      expectedSurface: 'omb-explore',
      expectedRuleId: 'symbol-lookup',
    },

    // File relation → omb-explore
    {
      description: 'how are the team runtime files related to each other',
      expectedKind: 'read_only_search',
      expectedSurface: 'omb-explore',
      expectedRuleId: 'read-only-grep',
    },
    {
      description: 'what are the import dependencies in the state layer',
      expectedKind: 'unknown',
      expectedSurface: 'normal-path',
      expectedRuleId: '',
    },
    {
      description: 'inspect the export relationships in the hooks directory',
      expectedKind: 'file_relation',
      expectedSurface: 'omb-explore',
      expectedRuleId: 'file-relation',
    },

    // Read-only grep → omb-explore
    {
      description: 'search for all occurrences of withAgentsLock',
      expectedKind: 'read_only_search',
      expectedSurface: 'omb-explore',
      expectedRuleId: 'read-only-grep',
    },
    {
      description: 'grep for pattern LockOptions in the codebase',
      expectedKind: 'read_only_search',
      expectedSurface: 'omb-explore',
      expectedRuleId: 'read-only-grep',
    },
    {
      description: 'find paths that match the state directory convention',
      expectedKind: 'read_only_search',
      expectedSurface: 'omb-explore',
      expectedRuleId: 'read-only-grep',
    },

    // Architecture overview → omb-explore
    {
      description: 'show me the architecture overview of the team system',
      expectedKind: 'code_modification',
      expectedSurface: 'normal-path',
      expectedRuleId: 'code-change',
    },
    {
      description: 'what is the structure of the hooks directory',
      expectedKind: 'unknown',
      expectedSurface: 'normal-path',
      expectedRuleId: '',
    },

    // Code change → normal-path
    {
      description: 'implement a new lock mechanism for the agents file',
      expectedKind: 'code_modification',
      expectedSurface: 'normal-path',
      expectedRuleId: 'code-change',
    },
    {
      description: 'fix the bug in the session stale detection',
      expectedKind: 'code_modification',
      expectedSurface: 'normal-path',
      expectedRuleId: 'code-change',
    },
    {
      description: 'refactor the overlay stripping logic',
      expectedKind: 'code_modification',
      expectedSurface: 'normal-path',
      expectedRuleId: 'code-change',
    },
    {
      description: 'add error handling to the recovery ledger',
      expectedKind: 'code_modification',
      expectedSurface: 'normal-path',
      expectedRuleId: 'code-change',
    },
    {
      description: 'write a new routing rule for diagram generation',
      expectedKind: 'code_modification',
      expectedSurface: 'normal-path',
      expectedRuleId: 'code-change',
    },

    // Command execution → normal-path
    {
      description: 'start the dev server and verify it responds',
      expectedKind: 'run_command',
      expectedSurface: 'normal-path',
      expectedRuleId: 'command-execution',
    },
    {
      description: 'launch the linter on the src directory',
      expectedKind: 'code_modification',
      expectedSurface: 'normal-path',
      expectedRuleId: 'code-change',
    },
    {
      description: 'execute the type checker for the project',
      expectedKind: 'run_command',
      expectedSurface: 'normal-path',
      expectedRuleId: 'command-execution',
    },

    // Multi-step verification → normal-path
    {
      description: 'verify the lock mechanism works under concurrent access',
      expectedKind: 'multi_step_verification',
      expectedSurface: 'normal-path',
      expectedRuleId: 'multi-step-verify',
    },
    {
      description: 'validate the routing rules cover all expected cases',
      expectedKind: 'multi_step_verification',
      expectedSurface: 'normal-path',
      expectedRuleId: 'multi-step-verify',
    },
    {
      description: 'diagnose why the session detection returns stale',
      expectedKind: 'multi_step_verification',
      expectedSurface: 'normal-path',
      expectedRuleId: 'multi-step-verify',
    },
  ];

  for (const tc of routingCases) {
    it(`classifies "${tc.description}" as ${tc.expectedKind} → ${tc.expectedSurface}`, () => {
      const kind = classifyTaskKind(tc.description);
      assert.equal(kind, tc.expectedKind);

      const rule = matchRoutingRule(tc.description);
      if (tc.expectedKind === 'unknown') {
        // unknown kind has no matching rule - should resolve to normal-path
        assert.equal(rule, null);
        const { surface } = resolveExploreSurface(tc.description);
        assert.equal(surface, 'normal-path');
      } else {
        assert.ok(rule, `expected a rule to match for "${tc.description}"`);
        assert.equal(rule.id, tc.expectedRuleId);
        assert.equal(rule.preferredSurface, tc.expectedSurface);
        const { surface } = resolveExploreSurface(tc.description);
        assert.equal(surface, tc.expectedSurface);
      }
    });
  }

  // ── Routing disabled → always normal-path ───────────────────────────

  it('resolves to normal-path when routing is explicitly disabled', () => {
    const { surface, rule } = resolveExploreSurface(
      'find all references to RuntimeBridge',
      { routingEnabled: false },
    );
    assert.equal(surface, 'normal-path');
    assert.equal(rule, null);
  });

  // ── Unknown/ambiguous prompts → normal-path ─────────────────────────

  it('routes unknown prompts to normal-path', () => {
    const { surface, rule } = resolveExploreSurface('help me with this thing');
    assert.equal(surface, 'normal-path');
    assert.equal(rule, null);
  });

  it('routes empty prompts to normal-path', () => {
    const { surface, rule } = resolveExploreSurface('');
    assert.equal(surface, 'normal-path');
    assert.equal(rule, null);
  });

  // ── Mutation overrides exploration ──────────────────────────────────

  it('mutation keywords override exploration keywords even when both are present', () => {
    // "find" is exploration, but "fix" is mutation — mutation wins
    const kind = classifyTaskKind('find and fix the bug in session handling');
    assert.equal(kind, 'code_modification');
    assert.equal(matchRoutingRule('find and fix the bug')?.preferredSurface, 'normal-path');
  });

  it('mutation keywords like module/feature/system override exploration', () => {
    // "module" is a mutation keyword — even in exploration-like context
    const kind = classifyTaskKind('explore the module structure');
    assert.equal(kind, 'code_modification');
  });

  // ── Specific mutation keyword edge cases ────────────────────────────

  it('test keyword triggers code_modification even with exploration words', () => {
    assert.equal(classifyTaskKind('search the test files'), 'code_modification');
  });

  it('build keyword triggers code_modification', () => {
    assert.equal(classifyTaskKind('build the project'), 'code_modification');
  });

  // ── isSimpleExplorationPrompt consistency ────────────────────────────

  it('isSimpleExplorationPrompt returns true for pure exploration prompts', () => {
    const pureExplorePrompts = [
      'find the definition of RuntimeBridge',
      'search for all occurrences of withAgentsLock',
      'grep for pattern LockOptions',
      'inspect the export relationships',
      'where is resolveCanonicalTeamStateRoot',
      'explore the hooks directory',
    ];
    for (const prompt of pureExplorePrompts) {
      assert.equal(
        isSimpleExplorationPrompt(prompt),
        true,
        `expected exploration prompt: "${prompt}"`,
      );
    }
  });

  it('isSimpleExplorationPrompt returns false for mutation prompts', () => {
    const mutationPrompts = [
      'implement a new lock mechanism',
      'fix the bug in the session stale detection',
      'refactor the overlay stripping logic',
      'add error handling to the recovery ledger',
      'write a new routing rule',
    ];
    for (const prompt of mutationPrompts) {
      assert.equal(
        isSimpleExplorationPrompt(prompt),
        false,
        `expected non-exploration prompt: "${prompt}"`,
      );
    }
  });

  it('isSimpleExplorationPrompt returns false for ambiguous prompts with mutation keywords', () => {
    assert.equal(isSimpleExplorationPrompt('find and fix the bug'), false);
    assert.equal(isSimpleExplorationPrompt('search the test files'), false);
  });
});
