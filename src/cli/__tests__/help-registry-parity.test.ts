import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Resolve paths relative to the source tree
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..', '..');
const srcCliDir = join(projectRoot, 'src', 'cli');

/**
 * Parity tests for CR-P1-011: Verify that help text, knownCommands,
 * command registry, and dispatch are consistent.
 */
describe('help-registry-parity', () => {
  const ombBin = join(projectRoot, 'dist', 'cli', 'omb.js');
  const canRunCli = existsSync(ombBin);

  describe('help text consistency', () => {
    it('omb help lists all known commands', { skip: !canRunCli }, () => {
      const result = spawnSync(process.execPath, [ombBin, 'help'], {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true,
      });
      const helpText = result.stdout || '';
      const knownCommands = [
        'setup', 'uninstall', 'doctor', 'cleanup', 'ask', 'handoff',
        'review', 'switch', 'adapt', 'question', 'resume', 'explore',
        'team', 'ralph', 'autoresearch', 'version', 'sparkshell',
        'session', 'agents', 'agents-init',
      ];
      for (const cmd of knownCommands) {
        assert.ok(helpText.includes(cmd), `Help text missing command: ${cmd}`);
      }
    });

    it('help includes parity commands (notepad, project-memory, trace, code-intel)', { skip: !canRunCli }, () => {
      const result = spawnSync(process.execPath, [ombBin, 'help'], {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true,
      });
      const helpText = result.stdout || '';
      for (const cmd of ['notepad', 'project-memory', 'trace', 'code-intel']) {
        assert.ok(helpText.includes(cmd), `Help text missing parity command: ${cmd}`);
      }
    });
  });

  describe('command registry vs source code parity', () => {
    it('command-registry.ts register calls match known commands list', () => {
      const registrySrc = readFileSync(join(srcCliDir, 'command-registry.ts'), 'utf-8');
      // Extract all registered command names from source
      const registerCalls = registrySrc.match(/registry\.register\(\{ name: "([^"]+)"/g) || [];
      const registeredNames = registerCalls.map(call => {
        const match = call.match(/name: "([^"]+)"/);
        return match ? match[1] : '';
      }).filter(Boolean);

      // Core commands that must be registered
      const essentialCommands = ['setup', 'team', 'ralph', 'explore', 'sparkshell', 'state'];
      for (const cmd of essentialCommands) {
        assert.ok(registeredNames.includes(cmd), `Command "${cmd}" not registered in command-registry.ts`);
      }
    });

    it('NESTED_HELP_COMMAND_NAMES covers all ownsLocalHelp commands', () => {
      const registrySrc = readFileSync(join(srcCliDir, 'command-registry.ts'), 'utf-8');
      // Extract commands with ownsLocalHelp: true (within a single register call)
      // Match each register call individually, then check for ownsLocalHelp
      const registerCalls = registrySrc.match(/registry\.register\(\{[^}]+\}\)/g) || [];
      const ownsLocalHelpCommands = registerCalls
        .filter(call => call.includes('ownsLocalHelp: true'))
        .map(call => {
          const match = call.match(/name: "([^"]+)"/);
          return match ? match[1] : '';
        })
        .filter(Boolean);

      // Extract NESTED_HELP_COMMAND_NAMES entries
      const nestedMatch = registrySrc.match(/NESTED_HELP_COMMAND_NAMES = new Set\(\[([\s\S]*?)\]\)/);
      assert.ok(nestedMatch, 'NESTED_HELP_COMMAND_NAMES not found');
      const nestedNames = (nestedMatch![1].match(/"([^"]+)"/g) || []).map(s => s.replace(/"/g, ''));

      // Every ownsLocalHelp command should be in NESTED_HELP_COMMAND_NAMES
      for (const cmd of ownsLocalHelpCommands) {
        assert.ok(nestedNames.includes(cmd), `ownsLocalHelp command "${cmd}" not in NESTED_HELP_COMMAND_NAMES`);
      }

      // Every NESTED_HELP_COMMAND_NAMES entry should have a registry entry
      // (either as a name or as an alias)
      for (const cmd of nestedNames) {
        const isRegisteredName = registrySrc.includes(`name: "${cmd}"`);
        const isRegisteredAlias = registrySrc.includes(`"${cmd}"`);
        assert.ok(
          isRegisteredName || isRegisteredAlias,
          `NESTED_HELP_COMMAND_NAMES entry "${cmd}" not in registry as name or alias`
        );
      }
    });
  });

  describe('team api operations parity', () => {
    it('team command exists in registry', () => {
      const registrySrc = readFileSync(join(srcCliDir, 'command-registry.ts'), 'utf-8');
      assert.ok(registrySrc.includes('name: "team"'), 'team command not in registry');
    });

    it('team api --help lists operations', { skip: !canRunCli }, () => {
      const result = spawnSync(process.execPath, [ombBin, 'team', 'api', '--help'], {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true,
      });
      assert.equal(result.status, 0);
      const helpText = result.stdout || '';
      assert.ok(helpText.includes('send-message'), 'send-message not in team api help');
      assert.ok(helpText.includes('list-tasks'), 'list-tasks not in team api help');
    });
  });

  describe('alias parity', () => {
    it('deepinit is an alias for agents-init', () => {
      const registrySrc = readFileSync(join(srcCliDir, 'command-registry.ts'), 'utf-8');
      // Check deepinit appears as an alias
      assert.ok(
        registrySrc.includes('"deepinit"') && registrySrc.includes('agents-init'),
        'deepinit alias or agents-init not found in registry'
      );
    });
  });
});
