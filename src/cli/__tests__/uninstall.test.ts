import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManagedCodexHooksConfig } from '../../config/codex-hooks.js';

function runOmb(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const ombBin = join(repoRoot, 'dist', 'cli', 'omb.js');
  const resolvedHome = envOverrides.HOME ?? process.env.HOME;
  const result = spawnSync(process.execPath, [ombBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...(resolvedHome && !envOverrides.CODEBUDDY_HOME ? { CODEBUDDY_HOME: join(resolvedHome, '.codebuddy') } : {}),
      ...envOverrides,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
  };
}

function shouldSkipForSpawnPermissions(err: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

/** Build a realistic OMB config.toml for testing */
function buildOmbConfig(): string {
  return [
    '# oh-my-codebuddy top-level settings (must be before any [table])',
    'notify = ["node", "/path/to/notify-hook.js"]',
    'model_reasoning_effort = "high"',
    'developer_instructions = "You have oh-my-codebuddy installed."',
    '',
    '[features]',
    'multi_agent = true',
    'child_agents_md = true',
    'codex_hooks = true',
    '',
    '# ============================================================',
    '# oh-my-codebuddy (OMB) Configuration',
    '# Managed by omb setup - manual edits preserved on next setup',
    '# ============================================================',
    '',
    '# OMB State Management MCP Server',
    '[mcp_servers.omb_state]',
    'command = "node"',
    'args = ["/path/to/state-server.js"]',
    'enabled = true',
    'startup_timeout_sec = 5',
    '',
    '# OMB Project Memory MCP Server',
    '[mcp_servers.omb_memory]',
    'command = "node"',
    'args = ["/path/to/memory-server.js"]',
    'enabled = true',
    'startup_timeout_sec = 5',
    '',
    '# OMB Code Intelligence MCP Server',
    '[mcp_servers.omb_code_intel]',
    'command = "node"',
    'args = ["/path/to/code-intel-server.js"]',
    'enabled = true',
    'startup_timeout_sec = 10',
    '',
    '# OMB Trace MCP Server',
    '[mcp_servers.omb_trace]',
    'command = "node"',
    'args = ["/path/to/trace-server.js"]',
    'enabled = true',
    'startup_timeout_sec = 5',
    '',
    '[agents.executor]',
    'description = "Code implementation"',
    'config_file = "/path/to/executor.toml"',
    '',
    '# OMB TUI StatusLine (Codex CLI v0.101.0+)',
    '[tui]',
    'status_line = ["model-with-reasoning", "git-branch"]',
    '',
    '# ============================================================',
    '# End oh-my-codebuddy',
    '',
  ].join('\n');
}

/** Build a config with OMB entries mixed with user entries */

function buildConfigWithSeededModelContext(): string {
  return [
    '# oh-my-codebuddy top-level settings (must be before any [table])',
    'notify = ["node", "/path/to/notify-hook.js"]',
    'model_reasoning_effort = "high"',
    'developer_instructions = "You have oh-my-codebuddy installed."',
    'model = "gpt-5.4"',
    'model_context_window = 1000000',
    'model_auto_compact_token_limit = 900000',
    '',
    '[features]',
    'multi_agent = true',
    'child_agents_md = true',
    'codex_hooks = true',
    '',
    '# ============================================================',
    '# oh-my-codebuddy (OMB) Configuration',
    '# Managed by omb setup - manual edits preserved on next setup',
    '# ============================================================',
    '',
    '[mcp_servers.omb_state]',
    'command = "node"',
    'args = ["/path/to/state-server.js"]',
    'enabled = true',
    '',
    '# ============================================================',
    '# End oh-my-codebuddy',
    '',
  ].join('\n');
}

function buildMixedConfig(): string {
  return [
    '# User settings',
    'model = "o4-mini"',
    '',
    '# oh-my-codebuddy top-level settings (must be before any [table])',
    'notify = ["node", "/path/to/notify-hook.js"]',
    'model_reasoning_effort = "high"',
    'developer_instructions = "You have oh-my-codebuddy installed."',
    '',
    '[features]',
    'multi_agent = true',
    'child_agents_md = true',
    'codex_hooks = true',
    'web_search = true',
    '',
    '[mcp_servers.user_custom]',
    'command = "custom"',
    'args = ["--flag"]',
    '',
    '# ============================================================',
    '# oh-my-codebuddy (OMB) Configuration',
    '# Managed by omb setup - manual edits preserved on next setup',
    '# ============================================================',
    '',
    '[mcp_servers.omb_state]',
    'command = "node"',
    'args = ["/path/to/state-server.js"]',
    'enabled = true',
    '',
    '[mcp_servers.omb_memory]',
    'command = "node"',
    'args = ["/path/to/memory-server.js"]',
    'enabled = true',
    '',
    '[mcp_servers.omb_code_intel]',
    'command = "node"',
    'args = ["/path/to/code-intel-server.js"]',
    'enabled = true',
    '',
    '[mcp_servers.omb_trace]',
    'command = "node"',
    'args = ["/path/to/trace-server.js"]',
    'enabled = true',
    '',
    '[agents.executor]',
    'description = "Code implementation"',
    'config_file = "/path/to/executor.toml"',
    '',
    '[tui]',
    'status_line = ["model-with-reasoning"]',
    '',
    '# ============================================================',
    '# End oh-my-codebuddy',
    '',
  ].join('\n');
}

describe('omb uninstall', () => {
  it('removes OMB block from config.toml with --dry-run', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codebuddy');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildOmbConfig());
      await writeFile(
        join(codexDir, 'hooks.json'),
        JSON.stringify(buildManagedCodexHooksConfig(wd), null, 2) + '\n',
      );

      const res = runOmb(wd, ['uninstall', '--dry-run'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /dry-run mode/);
      assert.match(res.stdout, /OMB configuration block/);
      assert.match(res.stdout, /hooks\.json/);
      assert.match(res.stdout, /omb_state/);

      // Config should NOT have been modified
      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      assert.match(config, /oh-my-codebuddy \(OMB\) Configuration/);
      assert.equal(existsSync(join(codexDir, 'hooks.json')), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes OMB block from config.toml', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codebuddy');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildOmbConfig());
      await writeFile(
        join(codexDir, 'hooks.json'),
        JSON.stringify(buildManagedCodexHooksConfig(wd), null, 2) + '\n',
      );

      const res = runOmb(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Removed OMB configuration block/);

      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      assert.doesNotMatch(config, /oh-my-codebuddy \(OMB\) Configuration/);
      assert.doesNotMatch(config, /omb_state/);
      assert.doesNotMatch(config, /omb_memory/);
      assert.doesNotMatch(config, /omb_code_intel/);
      assert.doesNotMatch(config, /omb_trace/);
      assert.doesNotMatch(config, /\[agents\.executor\]/);
      assert.doesNotMatch(config, /\[tui\]/);
      assert.doesNotMatch(config, /notify\s*=/);
      assert.doesNotMatch(config, /model_reasoning_effort\s*=/);
      assert.doesNotMatch(config, /developer_instructions\s*=/);
      assert.doesNotMatch(config, /multi_agent\s*=/);
      assert.doesNotMatch(config, /child_agents_md\s*=/);
      assert.doesNotMatch(config, /codex_hooks\s*=/);
      assert.equal(existsSync(join(codexDir, 'hooks.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('uninstalls both provider homes when persisted provider is both', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-both-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      const setupRes = runOmb(wd, ['setup', '--scope=project', '--provider=both'], {
        HOME: home,
      });
      if (shouldSkipForSpawnPermissions(setupRes.error)) return;
      assert.equal(setupRes.status, 0, setupRes.stderr || setupRes.stdout);

      const res = runOmb(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Resolved provider: both/);
      assert.match(res.stdout, /Cleaned 2 hooks artifact\(s\)\./);

      for (const providerDir of ['.codebuddy', '.codex']) {
        if (providerDir === '.codex') {
          // Codex provider still uses the codex-native config.toml; assert OMB
          // markers are cleaned out of it on uninstall.
          const config = await readFile(join(wd, providerDir, 'config.toml'), 'utf-8');
          assert.doesNotMatch(config, /oh-my-codebuddy \(OMB\) Configuration/);
          assert.doesNotMatch(config, /omb_state/);
          assert.doesNotMatch(config, /\[agents\.executor\]/);
        } else {
          // CodeBuddy provider no longer carries a codex-format config.toml at
          // all (ADR fix-codebuddy-config-toml-zombie). Assert the file is
          // gone, i.e. uninstall + prior setup together leave no residue.
          assert.equal(
            existsSync(join(wd, providerDir, 'config.toml')),
            false,
            'CodeBuddy provider should have no codex-format config.toml after uninstall',
          );
        }
        assert.equal(existsSync(join(wd, providerDir, 'hooks.json')), false);
        assert.equal(existsSync(join(wd, providerDir, 'prompts', 'executor.md')), false);
        assert.equal(existsSync(join(wd, providerDir, 'agents', 'executor.toml')), false);
        assert.equal(existsSync(join(wd, providerDir, 'skills', 'team', 'SKILL.md')), false);
      }
      assert.equal(existsSync(join(wd, 'AGENTS.md')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('uninstalls all provider homes when persisted provider is all', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-all-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      const setupRes = runOmb(wd, ['setup', '--scope=project', '--provider=all'], {
        HOME: home,
      });
      if (shouldSkipForSpawnPermissions(setupRes.error)) return;
      assert.equal(setupRes.status, 0, setupRes.stderr || setupRes.stdout);

      const res = runOmb(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Resolved provider: all/);
      assert.match(res.stdout, /Cleaned 3 hooks artifact\(s\)\./);

      for (const providerDir of ['.codebuddy', '.codex', '.claude']) {
        assert.equal(existsSync(join(wd, providerDir, 'hooks.json')), false, providerDir);
        assert.equal(existsSync(join(wd, providerDir, 'prompts', 'executor.md')), false, providerDir);
        assert.equal(existsSync(join(wd, providerDir, 'agents', 'executor.toml')), false, providerDir);
        assert.equal(existsSync(join(wd, providerDir, 'skills', 'team', 'SKILL.md')), false, providerDir);
      }
      assert.equal(existsSync(join(wd, '.claude', '.omb-config.json')), false);
      assert.equal(existsSync(join(wd, '.claude', 'config.toml')), false);
      assert.equal(existsSync(join(wd, 'AGENTS.md')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('preserves user config entries when removing OMB', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codebuddy');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildMixedConfig());

      const res = runOmb(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      // User settings preserved
      assert.match(config, /model = "o4-mini"/);
      assert.match(config, /\[mcp_servers\.user_custom\]/);
      assert.match(config, /web_search = true/);
      // OMB entries removed
      assert.doesNotMatch(config, /omb_state/);
      assert.doesNotMatch(config, /omb_memory/);
      assert.doesNotMatch(config, /notify\s*=.*node/);
      assert.doesNotMatch(config, /multi_agent/);
      assert.doesNotMatch(config, /child_agents_md/);
      assert.doesNotMatch(config, /codex_hooks/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves user hooks while removing OMB-managed wrappers', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codebuddy');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildOmbConfig());
      await writeFile(
        join(codexDir, 'hooks.json'),
        JSON.stringify(
          {
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    { type: 'command', command: 'node "/repo/dist/scripts/codex-native-hook.js"' },
                    { type: 'command', command: 'echo keep-me' },
                  ],
                },
              ],
            },
            version: 1,
          },
          null,
          2,
        ) + '\n',
      );

      const res = runOmb(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.equal(existsSync(join(codexDir, 'hooks.json')), true);

      const hooks = await readFile(join(codexDir, 'hooks.json'), 'utf-8');
      assert.match(hooks, /echo keep-me/);
      assert.match(hooks, /"version": 1/);
      assert.doesNotMatch(hooks, /codex-native-hook\.js/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('preserves seeded model/context keys during uninstall', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codebuddy');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildConfigWithSeededModelContext());

      const res = runOmb(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      assert.match(config, /^model = "gpt-5\.4"$/m);
      assert.match(config, /^model_context_window = 1000000$/m);
      assert.match(config, /^model_auto_compact_token_limit = 900000$/m);
      assert.doesNotMatch(config, /notify\s*=/);
      assert.doesNotMatch(config, /model_reasoning_effort\s*=/);
      assert.doesNotMatch(config, /developer_instructions\s*=/);
      assert.doesNotMatch(config, /oh-my-codebuddy \(OMB\) Configuration/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('--keep-config skips config.toml cleanup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codebuddy');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildOmbConfig());

      const res = runOmb(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /--keep-config/);

      // Config should NOT have been modified
      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      assert.match(config, /oh-my-codebuddy \(OMB\) Configuration/);
      assert.match(config, /omb_state/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('--purge removes .omb/ cache directory', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      // Create .omb/ directory with some files
      const ombDir = join(wd, '.omb');
      await mkdir(join(ombDir, 'state'), { recursive: true });
      await writeFile(join(ombDir, 'setup-scope.json'), JSON.stringify({ scope: 'user' }));
      await writeFile(join(ombDir, 'notepad.md'), '# notes');
      await writeFile(join(ombDir, 'state', 'ralph-state.json'), '{}');

      const res = runOmb(wd, ['uninstall', '--keep-config', '--purge'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /\.omb\/ cache directory/);

      assert.equal(existsSync(ombDir), false, '.omb/ directory should be removed');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('works with project scope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });

      // Create project-scoped setup
      const ombDir = join(wd, '.omb');
      const codexDir = join(wd, '.codebuddy');
      await mkdir(ombDir, { recursive: true });
      await mkdir(join(codexDir, 'prompts'), { recursive: true });
      await writeFile(join(ombDir, 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(join(codexDir, 'config.toml'), buildOmbConfig());
      // Install a prompt
      await writeFile(join(codexDir, 'prompts', 'executor.md'), '# executor');

      const res = runOmb(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Resolved scope: project/);

      // Project-local config.toml should be cleaned
      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      assert.doesNotMatch(config, /oh-my-codebuddy \(OMB\) Configuration/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('handles missing config.toml gracefully', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });

      const res = runOmb(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Nothing to remove/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('shows summary of what was removed', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codebuddy');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildOmbConfig());

      const res = runOmb(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Uninstall summary/);
      assert.match(res.stdout, /MCP servers: omb_state, omb_memory, omb_code_intel, omb_trace/);
      assert.match(res.stdout, /Agent entries: 1/);
      assert.match(res.stdout, /TUI status line section/);
      assert.match(res.stdout, /Top-level keys/);
      assert.match(res.stdout, /Feature flags/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('warns when overlapping legacy ~/.agents/skills remains after user-scope uninstall', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codebuddy');
      const canonicalHelp = join(codexDir, 'skills', 'help');
      const legacyHelp = join(home, '.agents', 'skills', 'help');
      await mkdir(canonicalHelp, { recursive: true });
      await mkdir(legacyHelp, { recursive: true });
      await writeFile(join(canonicalHelp, 'SKILL.md'), '# canonical help\n');
      await writeFile(join(legacyHelp, 'SKILL.md'), '# legacy help\n');

      const res = runOmb(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Warning: 1 overlapping skill names remain between .*\.codebuddy[\\/]+skills and .*\.agents[\\/]+skills; 1 differ in SKILL\.md content\. omb uninstall only removes the active canonical skill root; archive or remove ~\/\.agents\/skills if CodeBuddy still shows duplicates/,
      );
      assert.equal(existsSync(canonicalHelp), false, 'canonical OMB skill should be removed');
      assert.equal(existsSync(join(home, '.agents', 'skills')), true, 'legacy skill root should remain for manual cleanup');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('warns with Codex wording when --provider codex is used', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const canonicalHelp = join(codexDir, 'skills', 'help');
      const legacyHelp = join(home, '.agents', 'skills', 'help');
      await mkdir(canonicalHelp, { recursive: true });
      await mkdir(legacyHelp, { recursive: true });
      await writeFile(join(canonicalHelp, 'SKILL.md'), '# canonical help\n');
      await writeFile(join(legacyHelp, 'SKILL.md'), '# legacy help\n');

      const res = runOmb(wd, ['uninstall', '--provider', 'codex', '--keep-config'], {
        HOME: home,
        CODEX_HOME: codexDir,
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Warning: 1 overlapping skill names remain between .*\.codex[\\/]+skills and .*\.agents[\\/]+skills; 1 differ in SKILL\.md content\. omb uninstall only removes the active canonical skill root; archive or remove ~\/\.agents\/skills if Codex still shows duplicates/,
      );
      assert.equal(existsSync(canonicalHelp), false, 'canonical OMB skill should be removed');
      assert.equal(existsSync(join(home, '.agents', 'skills')), true, 'legacy skill root should remain for manual cleanup');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('warns when a distinct legacy ~/.agents/skills root remains after user-scope uninstall', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codebuddy');
      const canonicalHelp = join(codexDir, 'skills', 'help');
      const legacyDoctor = join(home, '.agents', 'skills', 'doctor');
      await mkdir(canonicalHelp, { recursive: true });
      await mkdir(legacyDoctor, { recursive: true });
      await writeFile(join(canonicalHelp, 'SKILL.md'), '# canonical help\n');
      await writeFile(join(legacyDoctor, 'SKILL.md'), '# legacy doctor\n');

      const res = runOmb(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Warning: legacy ~\/\.agents\/skills still exists \(1 skills\)\. omb uninstall does not remove that historical root automatically; archive or remove ~\/\.agents\/skills if CodeBuddy still shows stale or duplicate skills/,
      );
      assert.equal(existsSync(canonicalHelp), false, 'canonical OMB skill should be removed');
      assert.equal(existsSync(join(home, '.agents', 'skills')), true, 'legacy skill root should remain for manual cleanup');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('warns for both providers when --provider both is used', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-both-provider-warning-'));
    try {
      const home = join(wd, 'home');
      const codexHome = join(home, '.codex');
      const codebuddyHome = join(home, '.codebuddy');
      const cbHelp = join(codebuddyHome, 'skills', 'help');
      const cbLegacyHelp = join(home, '.agents', 'skills', 'help');
      const codexHelp = join(codexHome, 'skills', 'help');
      await mkdir(cbHelp, { recursive: true });
      await mkdir(cbLegacyHelp, { recursive: true });
      await mkdir(codexHelp, { recursive: true });
      await writeFile(join(cbHelp, 'SKILL.md'), '# cb canonical help\n');
      await writeFile(join(cbLegacyHelp, 'SKILL.md'), '# legacy help\n');
      await writeFile(join(codexHelp, 'SKILL.md'), '# codex canonical help\n');

      const res = runOmb(wd, ['uninstall', '--provider', 'both', '--keep-config'], {
        HOME: home,
        CODEX_HOME: codexHome,
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Warning: 1 overlapping skill names remain between .*\.codebuddy[\\/]skills and .*\.agents[\\/]skills; 1 differ in SKILL\.md content\. omb uninstall only removes the active canonical skill root; archive or remove ~\/\.agents\/skills if CodeBuddy still shows duplicates/,
      );
      assert.match(
        res.stdout,
        /Warning: 1 overlapping skill names remain between .*\.codex[\\/]skills and .*\.agents[\\/]skills; 1 differ in SKILL\.md content\. omb uninstall only removes the active canonical skill root; archive or remove ~\/\.agents\/skills if Codex still shows duplicates/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not warn about legacy ~/.agents/skills when none exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codebuddy');
      const canonicalHelp = join(codexDir, 'skills', 'help');
      await mkdir(canonicalHelp, { recursive: true });
      await writeFile(join(canonicalHelp, 'SKILL.md'), '# canonical help\n');

      const res = runOmb(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.doesNotMatch(res.stdout, /legacy ~\/\.agents\/skills still exists/);
      assert.doesNotMatch(res.stdout, /omb uninstall does not remove legacy ~\/\.agents\/skills/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not warn about legacy ~/.agents/skills during project-scope uninstall', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const projectSkillsHelp = join(wd, '.codebuddy', 'skills', 'help');
      const legacyHelp = join(home, '.agents', 'skills', 'help');
      await mkdir(projectSkillsHelp, { recursive: true });
      await mkdir(legacyHelp, { recursive: true });
      await mkdir(join(wd, '.omb'), { recursive: true });
      await writeFile(join(projectSkillsHelp, 'SKILL.md'), '# project help\n');
      await writeFile(join(legacyHelp, 'SKILL.md'), '# legacy help\n');
      await writeFile(join(wd, '.omb', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));

      const res = runOmb(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Resolved scope: project/);
      assert.doesNotMatch(res.stdout, /legacy ~\/\.agents\/skills still exists/);
      assert.doesNotMatch(res.stdout, /omb uninstall does not remove legacy ~\/\.agents\/skills/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not warn when legacy ~/.agents/skills is just a link to the canonical skills root', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-legacy-link-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codebuddy');
      const canonicalSkillsRoot = join(codexDir, 'skills');
      const canonicalSkill = join(canonicalSkillsRoot, 'doctor');
      const legacyRoot = join(home, '.agents', 'skills');
      await mkdir(canonicalSkill, { recursive: true });
      await mkdir(join(home, '.agents'), { recursive: true });
      await writeFile(join(canonicalSkill, 'SKILL.md'), '# canonical doctor\n');
      await symlink(
        canonicalSkillsRoot,
        legacyRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      const res = runOmb(wd, ['uninstall', '--keep-config'], { HOME: home, CODEBUDDY_HOME: codexDir });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.doesNotMatch(res.stdout, /legacy ~\/\.agents\/skills/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('--dry-run --purge does not actually remove .omb/ directory', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      const ombDir = join(wd, '.omb');
      await mkdir(join(ombDir, 'state'), { recursive: true });
      await writeFile(join(ombDir, 'setup-scope.json'), JSON.stringify({ scope: 'user' }));
      await writeFile(join(ombDir, 'notepad.md'), '# notes');

      const res = runOmb(wd, ['uninstall', '--keep-config', '--purge', '--dry-run'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /dry-run mode/);
      assert.match(res.stdout, /\.omb\/ cache directory/);

      // .omb/ should still exist
      assert.equal(existsSync(ombDir), true, '.omb/ should NOT be removed in dry-run');
      assert.equal(existsSync(join(ombDir, 'notepad.md')), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('second uninstall run reports nothing to remove (idempotent)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codebuddy');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildOmbConfig());

      const first = runOmb(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(first.error)) return;
      assert.equal(first.status, 0, first.stderr || first.stdout);
      assert.match(first.stdout, /Removed OMB configuration block/);

      const second = runOmb(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(second.error)) return;
      assert.equal(second.status, 0, second.stderr || second.stdout);
      assert.match(second.stdout, /Nothing to remove/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not delete user AGENTS.md that merely mentions oh-my-codebuddy', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      const userAgentsMd = '# My Agents\n\nDo not use oh-my-codebuddy for this project.\n';
      await writeFile(join(wd, 'AGENTS.md'), userAgentsMd);

      const res = runOmb(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      // User AGENTS.md should be preserved
      assert.equal(existsSync(join(wd, 'AGENTS.md')), true);
      const content = await readFile(join(wd, 'AGENTS.md'), 'utf-8');
      assert.equal(content, userAgentsMd);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes managed user-scope AGENTS.md from CODEX_HOME when provider is codex', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexHome = join(home, '.codex');
      await mkdir(codexHome, { recursive: true });
      await mkdir(join(wd, '.omb'), { recursive: true });
      await writeFile(join(wd, '.omb', 'setup-scope.json'), JSON.stringify({ scope: 'user', provider: 'codex' }));
      await writeFile(
        join(codexHome, 'AGENTS.md'),
        '<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->\n'
          + 'YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.\n'
          + 'DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.\n'
          + 'IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.\n'
          + '<!-- END AUTONOMY DIRECTIVE -->\n'
          + '<!-- omb:generated:agents-md -->\n'
          + '# oh-my-codebuddy - Intelligent Multi-Agent Orchestration\n',
      );

      const res = runOmb(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.equal(existsSync(join(codexHome, 'AGENTS.md')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes setup-scope.json and hud-config.json without --purge', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-uninstall-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      const ombDir = join(wd, '.omb');
      await mkdir(ombDir, { recursive: true });
      await writeFile(join(ombDir, 'setup-scope.json'), JSON.stringify({ scope: 'user' }));
      await writeFile(join(ombDir, 'hud-config.json'), JSON.stringify({ preset: 'focused' }));
      await writeFile(join(ombDir, 'notepad.md'), '# keep this');

      const res = runOmb(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      assert.equal(existsSync(join(ombDir, 'setup-scope.json')), false);
      assert.equal(existsSync(join(ombDir, 'hud-config.json')), false);
      // notepad.md should still exist (not purged)
      assert.equal(existsSync(join(ombDir, 'notepad.md')), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('stripOmbFeatureFlags', () => {
  it('removes OMB feature flags and preserves user flags', async () => {
    const { stripOmbFeatureFlags } = await import('../../config/generator.js');

    const config = [
      '[features]',
      'multi_agent = true',
      'child_agents_md = true',
      'web_search = true',
      '',
    ].join('\n');

    const result = stripOmbFeatureFlags(config);
    assert.doesNotMatch(result, /multi_agent/);
    assert.doesNotMatch(result, /child_agents_md/);
    assert.match(result, /web_search = true/);
    assert.match(result, /\[features\]/);
  });

  it('removes [features] section if it becomes empty', async () => {
    const { stripOmbFeatureFlags } = await import('../../config/generator.js');

    const config = [
      '[features]',
      'multi_agent = true',
      'child_agents_md = true',
      '',
    ].join('\n');

    const result = stripOmbFeatureFlags(config);
    assert.doesNotMatch(result, /\[features\]/);
    assert.doesNotMatch(result, /multi_agent/);
  });

  it('handles config without [features] section', async () => {
    const { stripOmbFeatureFlags } = await import('../../config/generator.js');

    const config = 'model = "o4-mini"\n';
    const result = stripOmbFeatureFlags(config);
    assert.equal(result, config);
  });
});
