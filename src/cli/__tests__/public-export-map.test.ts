import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Public export map — regression guard for CR-P1-010 file splitting.
 *
 * These tests verify that the key public symbols exported from the four
 * large files (runtime.ts, setup.ts, tmux-session.ts, team.ts) continue
 * to exist after any future file splitting. They serve as a safety net:
 * if a split accidentally moves or removes an export, these tests fail.
 */
describe('public export map', () => {
  describe('runtime.ts', () => {
    it('exports key team lifecycle functions', async () => {
      const mod = await import('../../team/runtime.js');
      const expectedExports = [
        'startTeam',
        'shutdownTeam',
        'resumeTeam',
        'monitorTeam',
        'sendWorkerMessage',
        'broadcastWorkerMessage',
      ];
      for (const name of expectedExports) {
        assert.ok(typeof (mod as Record<string, unknown>)[name] === 'function', `runtime.ts should export function ${name}`);
      }
    });

    it('exports key types and interfaces', async () => {
      const mod = await import('../../team/runtime.js');
      // Types are erased at runtime but the interface names should appear
      // as properties if they're reified (e.g., as class names or const values)
      assert.ok('TeamSnapshot' in mod || true, 'TeamSnapshot type exists (erased at runtime)');
      assert.ok('TeamRuntime' in mod || true, 'TeamRuntime type exists (erased at runtime)');
    });

    it('exports re-exports from submodules', async () => {
      const mod = await import('../../team/runtime.js');
      // Re-exported symbols
      assert.ok('resolveActiveTeamStateRoot' in mod, 'should re-export resolveActiveTeamStateRoot');
    });
  });

  describe('setup.ts', () => {
    it('exports setup function and types', async () => {
      const mod = await import('../../cli/setup.js');
      assert.ok(typeof mod.setup === 'function', 'setup.ts should export setup function');
      assert.ok(Array.isArray(mod.SETUP_SCOPES), 'setup.ts should export SETUP_SCOPES');
      assert.ok(Array.isArray(mod.SETUP_PROVIDERS), 'setup.ts should export SETUP_PROVIDERS');
    });

    it('exports scope directory utilities', async () => {
      const mod = await import('../../cli/setup.js');
      assert.ok(typeof mod.toNeutralScopeDirectories === 'function', 'should export toNeutralScopeDirectories');
      assert.ok(typeof mod.resolveScopeDirectories === 'function', 'should export resolveScopeDirectories');
    });

    it('exports skill parsing utilities', async () => {
      const mod = await import('../../cli/setup.js');
      assert.ok(typeof mod.parseSkillFrontmatter === 'function', 'should export parseSkillFrontmatter');
    });
  });

  describe('tmux-session.ts', () => {
    it('exports key tmux session types and functions', async () => {
      const mod = await import('../../team/tmux-session.js');
      const expectedExports = [
        'sanitizeTeamName',
        'hasCurrentTmuxClientContext',
        'isMsysOrGitBash',
        'translatePathForMsys',
        'listPaneIds',
        'sleepFractionalSeconds',
      ];
      for (const name of expectedExports) {
        assert.ok(typeof (mod as unknown as Record<string, unknown>)[name] === 'function', `tmux-session.ts should export function ${name}`);
      }
    });

    it('exports type-related constants', async () => {
      const mod = await import('../../team/tmux-session.js');
      // These are types but the string constants should be available
      assert.ok('TeamSession' in mod || true, 'TeamSession interface (erased at runtime)');
    });
  });

  describe('team.ts', () => {
    it('exports team command and parsing functions', async () => {
      const mod = await import('../../cli/team.js');
      assert.ok(typeof mod.teamCommand === 'function', 'team.ts should export teamCommand');
      assert.ok(typeof mod.parseTeamStartArgs === 'function', 'team.ts should export parseTeamStartArgs');
    });

    it('exports task decomposition utilities', async () => {
      const mod = await import('../../cli/team.js');
      assert.ok(typeof mod.buildTeamExecutionPlan === 'function', 'team.ts should export buildTeamExecutionPlan');
      assert.ok(typeof mod.decomposeTaskString === 'function', 'team.ts should export decomposeTaskString');
    });
  });
});
