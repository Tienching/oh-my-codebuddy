/**
 * omb doctor - Validate oh-my-codebuddy installation
 */

import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { parse as parseToml } from '@iarna/toml';
import {
  claudeHome, codebuddyHome, codebuddyConfigPath, codebuddyPromptsDir,
  userSkillsDir, ombStateDir, detectLegacySkillRootOverlap,
} from '../utils/paths.js';
import { classifySpawnError, spawnPlatformCommandSync } from '../utils/platform-command.js';
import { getCatalogExpectations } from './catalog-contract.js';
import { resolvePackagedExploreHarnessCommand, EXPLORE_BIN_ENV } from './explore.js';
import { getPackageRoot } from '../utils/package.js';
import { getDefaultBridge, isBridgeEnabled } from '../runtime/bridge.js';
import { OMB_EXPLORE_CMD_ENV, isExploreCommandRoutingEnabled } from '../hooks/explore-routing.js';
import { triagePrompt } from '../hooks/triage-heuristic.js';
import { readTriageConfig } from '../hooks/triage-config.js';
import { isLeaderRuntimeStale } from '../team/leader-activity.js';
import { CLAUDE_BIN, CODEBUDDY_BIN, CODEX_BIN } from './constants.js';

interface DoctorOptions {
  verbose?: boolean;
  force?: boolean;
  dryRun?: boolean;
  team?: boolean;
  scope?: DoctorSetupScope;
  provider?: DoctorSetupProvider;
}

interface Check {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

type DoctorSetupScope = 'user' | 'project';
type DoctorSetupProvider = 'codebuddy' | 'codex' | 'claude' | 'both' | 'all';
type DoctorTargetProvider = Exclude<DoctorSetupProvider, 'both' | 'all'>;

interface DoctorScopeResolution {
  scope: DoctorSetupScope;
  provider: DoctorSetupProvider;
  source: 'persisted' | 'default';
}

interface DoctorPaths {
  codebuddyHomeDir: string;
  configPath: string;
  hooksPath: string;
  /**
   * For claude, `hooksPath` points at `<home>/hooks/hooks.json` (subdirectory,
   * the path Claude CLI actually reads). `hooksLegacyFlatPath` points at
   * `<home>/hooks.json` so doctor can detect if a user or a previous OMB
   * version wrote a flat file that Claude would silently ignore. Unset for
   * codebuddy/codex where the flat path IS the canonical path.
   */
  hooksLegacyFlatPath?: string;
  promptsDir: string;
  skillsDir: string;
  stateDir: string;
}

interface DoctorTarget {
  provider: DoctorTargetProvider;
  paths: DoctorPaths;
}

const LEGACY_SCOPE_MIGRATION: Record<string, DoctorSetupScope> = {
  'project-local': 'project',
};

async function resolveDoctorScope(cwd: string): Promise<DoctorScopeResolution> {
  const scopePath = join(cwd, '.omb', 'setup-scope.json');
  if (!existsSync(scopePath)) {
    return { scope: 'user', provider: 'codebuddy', source: 'default' };
  }

  try {
    const raw = await readFile(scopePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<{ provider: string; scope: string }>;
    const provider =
      parsed.provider === 'codex' ||
      parsed.provider === 'claude' ||
      parsed.provider === 'both' ||
      parsed.provider === 'all'
        ? parsed.provider
        : 'codebuddy';
    if (typeof parsed.scope === 'string') {
      if (parsed.scope === 'user' || parsed.scope === 'project') {
        return { scope: parsed.scope, provider, source: 'persisted' };
      }
      const migrated = LEGACY_SCOPE_MIGRATION[parsed.scope];
      if (migrated) {
        return { scope: migrated, provider, source: 'persisted' };
      }
    }
  } catch {
    // ignore invalid persisted scope and fall back to default
  }

  return { scope: 'user', provider: 'codebuddy', source: 'default' };
}

function codexProviderHome(): string {
  const explicit = String(process.env.CODEX_HOME ?? '').trim();
  return explicit !== '' ? explicit : join(homedir(), '.codex');
}

function resolveDoctorPaths(
  cwd: string,
  scope: DoctorSetupScope,
  provider: DoctorTargetProvider,
): DoctorPaths {
  if (scope === 'project') {
    const codebuddyHomeDir = join(cwd, providerProjectDirName(provider));
    return {
      codebuddyHomeDir,
      configPath: join(codebuddyHomeDir, 'config.toml'),
      // Claude CLI reads hooks from `<home>/hooks/hooks.json` (subdirectory);
      // codebuddy/codex use the flat `<home>/hooks.json` layout.
      hooksPath:
        provider === 'claude'
          ? join(codebuddyHomeDir, 'hooks', 'hooks.json')
          : join(codebuddyHomeDir, 'hooks.json'),
      hooksLegacyFlatPath:
        provider === 'claude' ? join(codebuddyHomeDir, 'hooks.json') : undefined,
      promptsDir: join(codebuddyHomeDir, 'prompts'),
      skillsDir: join(codebuddyHomeDir, 'skills'),
      stateDir: ombStateDir(cwd),
    };
  }

  if (provider === 'codex') {
    const codebuddyHomeDir = codexProviderHome();
    return {
      codebuddyHomeDir,
      configPath: join(codebuddyHomeDir, 'config.toml'),
      hooksPath: join(codebuddyHomeDir, 'hooks.json'),
      promptsDir: join(codebuddyHomeDir, 'prompts'),
      skillsDir: join(codebuddyHomeDir, 'skills'),
      stateDir: ombStateDir(cwd),
    };
  }
  if (provider === 'claude') {
    const codebuddyHomeDir = claudeHome();
    return {
      codebuddyHomeDir,
      configPath: join(codebuddyHomeDir, 'config.toml'),
      hooksPath: join(codebuddyHomeDir, 'hooks', 'hooks.json'),
      hooksLegacyFlatPath: join(codebuddyHomeDir, 'hooks.json'),
      promptsDir: join(codebuddyHomeDir, 'prompts'),
      skillsDir: join(codebuddyHomeDir, 'skills'),
      stateDir: ombStateDir(cwd),
    };
  }

  return {
    codebuddyHomeDir: codebuddyHome(),
    configPath: codebuddyConfigPath(),
    hooksPath: join(codebuddyHome(), 'hooks.json'),
    promptsDir: codebuddyPromptsDir(),
    skillsDir: userSkillsDir(),
    stateDir: ombStateDir(cwd),
  };
}

function doctorProviderTargets(provider: DoctorSetupProvider): DoctorTargetProvider[] {
  switch (provider) {
    case 'both':
      return ['codebuddy', 'codex'];
    case 'all':
      return ['codebuddy', 'codex', 'claude'];
    case 'codebuddy':
    case 'codex':
    case 'claude':
      return [provider];
  }
}

function providerDisplayName(provider: DoctorTargetProvider): string {
  switch (provider) {
    case 'codebuddy':
      return 'CodeBuddy';
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
  }
}

function providerProjectDirName(provider: DoctorTargetProvider): string {
  switch (provider) {
    case 'codebuddy':
      return '.codebuddy';
    case 'codex':
      return '.codex';
    case 'claude':
      return '.claude';
  }
}

function resolveDoctorTargets(
  cwd: string,
  scope: DoctorSetupScope,
  provider: DoctorSetupProvider,
): DoctorTarget[] {
  return doctorProviderTargets(provider).map((targetProvider) => ({
    provider: targetProvider,
    paths: resolveDoctorPaths(cwd, scope, targetProvider),
  }));
}

function scopedProviderCheck(
  check: Check,
  target: DoctorTarget,
  multiProvider: boolean,
): Check {
  if (!multiProvider) return check;
  return {
    ...check,
    name: `${providerDisplayName(target.provider)} ${check.name}`,
  };
}

export async function doctor(options: DoctorOptions = {}): Promise<void> {
  if (options.team) {
    await doctorTeam();
    return;
  }

  const cwd = process.cwd();
  const scopeResolution = await resolveDoctorScope(cwd);
  const resolvedScope = options.scope ?? scopeResolution.scope;
  const resolvedProvider = options.provider ?? scopeResolution.provider;
  const targets = resolveDoctorTargets(cwd, resolvedScope, resolvedProvider);
  const multiProvider = targets.length > 1;
  const scopeSourceMessage = options.scope
    ? ' (from --scope)'
    : scopeResolution.source === 'persisted'
      ? ' (from .omb/setup-scope.json)'
      : '';
  const providerSourceMessage = options.provider ? ' (from --provider)' : '';

  console.log('oh-my-codebuddy doctor');
  console.log('======================\n');
  console.log(`Resolved setup scope: ${resolvedScope}${scopeSourceMessage}\n`);
  if (resolvedProvider !== 'codebuddy') {
    console.log(`Resolved setup provider: ${resolvedProvider}${providerSourceMessage}\n`);
  }

  const checks: Check[] = [];

  // Check 1: Provider CLI installed
  for (const target of targets) {
    checks.push(checkProviderCli(target.provider));
  }

  // Check 2: Node.js version
  checks.push(checkNodeVersion());

  // Check 2.5: Explore harness readiness
  checks.push(checkExploreHarness());

  for (const target of targets) {
    const { paths } = target;

    // Check 3: Provider home directory
    checks.push(checkDirectory(
      `${providerDisplayName(target.provider)} home`,
      paths.codebuddyHomeDir,
    ));

    // Check 4: Config file
    checks.push(scopedProviderCheck(await checkConfig(paths.configPath, target.provider), target, multiProvider));

    // Check 4.5: Explore routing default
    checks.push(scopedProviderCheck(await checkExploreRouting(paths.configPath, target.provider), target, multiProvider));

    // Check 5: Prompts installed
    checks.push(scopedProviderCheck(await checkPrompts(paths.promptsDir), target, multiProvider));

    // Check 6: Skills installed
    checks.push(scopedProviderCheck(await checkSkills(paths.skillsDir), target, multiProvider));

    // Check 6.5: Legacy/current skill-root overlap
    if (resolvedScope === 'user') {
      checks.push(
        scopedProviderCheck(
          await checkLegacySkillRootOverlap(paths.skillsDir, providerDisplayName(target.provider)),
          target,
          multiProvider,
        ),
      );
    }

    // Check 7: AGENTS.md in user provider home
    if (resolvedScope === 'user') {
      checks.push(scopedProviderCheck(checkAgentsMd(resolvedScope, paths.codebuddyHomeDir), target, multiProvider));
    }
  }

  // Check 7: Shared project AGENTS.md
  if (resolvedScope === 'project') {
    checks.push(checkAgentsMd(resolvedScope, targets[0]!.paths.codebuddyHomeDir));
  }

  // Check 8: State directory
  checks.push(checkDirectory('State dir', targets[0]!.paths.stateDir));

  // Check 8.5: OMB-managed hooks installed and aimed at current pkgRoot.
  // Provider-aware: claude uses a subdirectory path and also gets a legacy
  // flat-path guard; codebuddy/codex use the flat path directly.
  const packageRootForHooks = getPackageRoot();
  for (const target of targets) {
    const hooksChecks = await checkHooks(
      target.paths.hooksPath,
      target.provider,
      packageRootForHooks,
      target.paths.hooksLegacyFlatPath,
    );
    for (const c of hooksChecks) {
      checks.push(scopedProviderCheck(c, target, multiProvider));
    }
  }

  // Check 9: MCP servers configured
  for (const target of targets) {
    checks.push(scopedProviderCheck(await checkMcpServers(target.paths.configPath, target.provider), target, multiProvider));
  }

  // Check 10: Prompt triage
  checks.push(checkPromptTriage());

  // Print results
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const check of checks) {
    const icon = check.status === 'pass' ? '[OK]' : check.status === 'warn' ? '[!!]' : '[XX]';
    console.log(`  ${icon} ${check.name}: ${check.message}`);
    if (check.status === 'pass') passCount++;
    else if (check.status === 'warn') warnCount++;
    else failCount++;
  }

  console.log(`\nResults: ${passCount} passed, ${warnCount} warnings, ${failCount} failed`);

  if (failCount > 0) {
    console.log('\nRun "omb setup" to fix installation issues.');
  } else if (warnCount > 0) {
    console.log('\nRun "omb setup --force" to refresh all components.');
  } else {
    console.log('\nAll checks passed! oh-my-codebuddy is ready.');
  }
}

interface TeamDoctorIssue {
  code: 'delayed_status_lag' | 'slow_shutdown' | 'orphan_tmux_session' | 'resume_blocker' | 'stale_leader';
  message: string;
  severity: 'warn' | 'fail';
}

async function doctorTeam(): Promise<void> {
  console.log('oh-my-codebuddy doctor --team');
  console.log('=============================\n');

  const issues = await collectTeamDoctorIssues(process.cwd());
  if (issues.length === 0) {
    console.log('  [OK] team diagnostics: no issues');
    console.log('\nAll team checks passed.');
    return;
  }

  const failureCount = issues.filter(issue => issue.severity === 'fail').length;
  const warningCount = issues.length - failureCount;

  for (const issue of issues) {
    const icon = issue.severity === 'warn' ? '[!!]' : '[XX]';
    console.log(`  ${icon} ${issue.code}: ${issue.message}`);
  }

  console.log(`\nResults: ${warningCount} warnings, ${failureCount} failed`);
  // Ensure non-zero exit for `omb doctor --team` failures.
  if (failureCount > 0) process.exitCode = 1;
}

async function collectTeamDoctorIssues(cwd: string): Promise<TeamDoctorIssue[]> {
  const issues: TeamDoctorIssue[] = [];
  const stateDir = ombStateDir(cwd);
  const teamsRoot = join(stateDir, 'team');
  const nowMs = Date.now();
  const lagThresholdMs = 60_000;
  const shutdownThresholdMs = 30_000;
  const leaderStaleThresholdMs = 180_000;

  // Rust-first: if the runtime bridge is enabled, use Rust-authored readiness
  // and authority as the semantic truth source for runtime health.
  if (isBridgeEnabled()) {
    const bridge = getDefaultBridge(stateDir);
    const readiness = bridge.readReadiness();
    const authority = bridge.readAuthority();
    if (readiness && !readiness.ready) {
      for (const reason of readiness.reasons) {
        issues.push({
          code: 'resume_blocker',
          message: `runtime not ready: ${reason}`,
          severity: 'fail',
        });
      }
    }
    if (authority?.stale) {
      issues.push({
        code: 'stale_leader',
        message: `authority stale (owner: ${authority.owner ?? 'unknown'}): ${authority.stale_reason ?? 'unknown reason'}`,
        severity: 'fail',
      });
    }
  }

  const teamDirs: string[] = [];
  if (existsSync(teamsRoot)) {
    const entries = await readdir(teamsRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) teamDirs.push(e.name);
    }
  }

  const tmuxSessions = listTeamTmuxSessions();
  const tmuxUnavailable = tmuxSessions === null;
  const knownTeamSessions = new Set<string>();

  for (const teamName of teamDirs) {
    const teamDir = join(teamsRoot, teamName);
    const manifestPath = join(teamDir, 'manifest.v2.json');
    const configPath = join(teamDir, 'config.json');

    let tmuxSession = `omb-team-${teamName}`;
    if (existsSync(manifestPath)) {
      try {
        const raw = await readFile(manifestPath, 'utf-8');
        const parsed = JSON.parse(raw) as { tmux_session?: string };
        if (typeof parsed.tmux_session === 'string' && parsed.tmux_session.trim() !== '') {
          tmuxSession = parsed.tmux_session;
        }
      } catch {
        // ignore malformed manifest
      }
    } else if (existsSync(configPath)) {
      try {
        const raw = await readFile(configPath, 'utf-8');
        const parsed = JSON.parse(raw) as { tmux_session?: string };
        if (typeof parsed.tmux_session === 'string' && parsed.tmux_session.trim() !== '') {
          tmuxSession = parsed.tmux_session;
        }
      } catch {
        // ignore malformed config
      }
    }

    knownTeamSessions.add(tmuxSession);

    // resume_blocker: only meaningful if tmux is available to query
    if (!tmuxUnavailable && !tmuxSessions.has(tmuxSession)) {
      issues.push({
        code: 'resume_blocker',
        message: `${teamName} references missing tmux session ${tmuxSession}`,
        severity: 'fail',
      });
    }

    // delayed_status_lag + slow_shutdown checks
    const workersRoot = join(teamDir, 'workers');
    if (!existsSync(workersRoot)) continue;
    const workers = await readdir(workersRoot, { withFileTypes: true });
    for (const worker of workers) {
      if (!worker.isDirectory()) continue;
      const workerDir = join(workersRoot, worker.name);
      const statusPath = join(workerDir, 'status.json');
      const heartbeatPath = join(workerDir, 'heartbeat.json');
      const shutdownReqPath = join(workerDir, 'shutdown-request.json');
      const shutdownAckPath = join(workerDir, 'shutdown-ack.json');

      if (existsSync(statusPath) && existsSync(heartbeatPath)) {
        try {
          const [statusRaw, hbRaw] = await Promise.all([
            readFile(statusPath, 'utf-8'),
            readFile(heartbeatPath, 'utf-8'),
          ]);
          const status = JSON.parse(statusRaw) as { state?: string };
          const hb = JSON.parse(hbRaw) as { last_turn_at?: string };
          const lastTurnMs = hb.last_turn_at ? Date.parse(hb.last_turn_at) : NaN;
          if (status.state === 'working' && Number.isFinite(lastTurnMs) && nowMs - lastTurnMs > lagThresholdMs) {
            issues.push({
              code: 'delayed_status_lag',
              message: `${teamName}/${worker.name} working with stale heartbeat`,
              severity: 'fail',
            });
          }
        } catch {
          // ignore malformed files
        }
      }

      if (existsSync(shutdownReqPath) && !existsSync(shutdownAckPath)) {
        try {
          const reqRaw = await readFile(shutdownReqPath, 'utf-8');
          const req = JSON.parse(reqRaw) as { requested_at?: string };
          const reqMs = req.requested_at ? Date.parse(req.requested_at) : NaN;
          if (Number.isFinite(reqMs) && nowMs - reqMs > shutdownThresholdMs) {
            issues.push({
              code: 'slow_shutdown',
              message: `${teamName}/${worker.name} has stale shutdown request without ack`,
              severity: 'fail',
            });
          }
        } catch {
          // ignore malformed files
        }
      }
    }
  }

  // stale_leader: team has active workers but leader has no recent activity
  const hudStatePath = join(stateDir, 'hud-state.json');
  const leaderActivityPath = join(stateDir, 'leader-runtime-activity.json');
  if ((existsSync(hudStatePath) || existsSync(leaderActivityPath)) && teamDirs.length > 0) {
    try {
      const leaderIsStale = await isLeaderRuntimeStale(stateDir, leaderStaleThresholdMs, nowMs);

      if (leaderIsStale && !tmuxUnavailable) {
        // Check if any team tmux session has live worker panes
        for (const teamName of teamDirs) {
          const session = knownTeamSessions.has(`omb-team-${teamName}`)
            ? `omb-team-${teamName}`
            : [...knownTeamSessions].find(s => s.includes(teamName));
          if (!session || !tmuxSessions.has(session)) continue;
          issues.push({
            code: 'stale_leader',
            message: `${teamName} has active tmux session but leader has no recent activity`,
            severity: 'fail',
          });
        }
      }
    } catch {
      // ignore malformed HUD state
    }
  }

  // orphan_tmux_session: session exists but no matching team state
  if (!tmuxUnavailable) {
    for (const session of tmuxSessions) {
      if (!knownTeamSessions.has(session)) {
        issues.push({
          code: 'orphan_tmux_session',
          message: `${session} exists without matching team state (possibly external project)`,
          severity: 'warn',
        });
      }
    }
  }

  return dedupeIssues(issues);
}

function dedupeIssues(issues: TeamDoctorIssue[]): TeamDoctorIssue[] {
  const seen = new Set<string>();
  const out: TeamDoctorIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function listTeamTmuxSessions(): Set<string> | null {
  const { result: res } = spawnPlatformCommandSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf-8' });
  if (res.error) {
    // tmux binary unavailable or not executable.
    return null;
  }

  if (res.status !== 0) {
    const stderr = (res.stderr || '').toLowerCase();
    // tmux installed but no server/session is running.
    if (stderr.includes('no server running') || stderr.includes('failed to connect to server')) {
      return new Set();
    }
    return null;
  }

  const sessions = (res.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('omb-team-'));
  return new Set(sessions);
}

function checkProviderCli(provider: DoctorTargetProvider): Check {
  const binary = (() => {
    switch (provider) {
      case 'codebuddy':
        return CODEBUDDY_BIN;
      case 'codex':
        return CODEX_BIN;
      case 'claude':
        return CLAUDE_BIN;
    }
  })();
  const label = `${providerDisplayName(provider)} CLI`;
  const { result } = spawnPlatformCommandSync(binary, ['--version'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const kind = classifySpawnError(result.error as NodeJS.ErrnoException);
    if (kind === 'missing') {
      const installHint = (() => {
        switch (provider) {
          case 'codebuddy':
            return 'install with: npm install -g @tencent-ai/codebuddy-code';
          case 'codex':
            return 'install Codex CLI and ensure codex is on PATH';
          case 'claude':
            return 'install Claude Code CLI and ensure claude is on PATH';
        }
      })();
      return { name: label, status: 'fail', message: `not found - ${installHint}` };
    }
    if (kind === 'blocked') {
      return {
        name: label,
        status: 'fail',
        message: `found but could not be executed in this environment (${code || 'blocked'})`,
      };
    }
    return {
      name: label,
      status: 'fail',
      message: `probe failed - ${result.error.message}`,
    };
  }
  if (result.status === 0) {
    const version = (result.stdout || '').trim().split('\n')[0] ?? '';
    return { name: label, status: 'pass', message: `installed (${version})` };
  }
  const stderr = (result.stderr || '').trim();
  return {
    name: label,
    status: 'fail',
    message: stderr !== '' ? `probe failed - ${stderr}` : `probe failed with exit ${result.status}`,
  };
}

function checkNodeVersion(): Check {
  const major = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (isNaN(major)) {
    return { name: 'Node.js', status: 'fail', message: `v${process.versions.node} (unable to parse major version)` };
  }
  if (major >= 20) {
    return { name: 'Node.js', status: 'pass', message: `v${process.versions.node}` };
  }
  return { name: 'Node.js', status: 'fail', message: `v${process.versions.node} (need >= 20)` };
}

function checkExploreHarness(): Check {
  const packageRoot = getPackageRoot();
  const manifestPath = join(packageRoot, 'crates', 'omb-explore', 'Cargo.toml');
  if (!existsSync(manifestPath)) {
    return {
      name: 'Explore Harness',
      status: 'warn',
      message: 'Rust harness sources not found in this install (omb explore unavailable until packaged or OMB_EXPLORE_BIN is set)',
    };
  }

  const override = process.env[EXPLORE_BIN_ENV]?.trim();
  if (override) {
    const resolved = join(packageRoot, override);
    if (existsSync(override) || existsSync(resolved)) {
      return {
        name: 'Explore Harness',
        status: 'pass',
        message: `${EXPLORE_BIN_ENV} configured (${override})`,
      };
    }
    return {
      name: 'Explore Harness',
      status: 'warn',
      message: `OMB_EXPLORE_BIN is set but path was not found (${override})`,
    };
  }

  const packaged = resolvePackagedExploreHarnessCommand(packageRoot);
  if (packaged) {
    return {
      name: 'Explore Harness',
      status: 'pass',
      message: `ready (packaged native binary: ${packaged.command})`,
    };
  }

  const { result } = spawnPlatformCommandSync('cargo', ['--version'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) {
    const kind = classifySpawnError(result.error as NodeJS.ErrnoException);
    if (kind === 'missing') {
      return {
        name: 'Explore Harness',
        status: 'warn',
        message: `Rust harness sources are packaged, but no compatible packaged prebuilt or cargo was found (install Rust or set ${EXPLORE_BIN_ENV} for omb explore)`,
      };
    }
    return {
      name: 'Explore Harness',
      status: 'warn',
      message: `Rust harness sources are packaged, but cargo probe failed (${result.error.message})`,
    };
  }

  if (result.status === 0) {
    const version = (result.stdout || '').trim();
    return {
      name: 'Explore Harness',
      status: 'pass',
      message: `ready (${version || 'cargo available'})`,
    };
  }

  return {
    name: 'Explore Harness',
    status: 'warn',
    message: `Rust harness sources are packaged, but cargo probe failed with exit ${result.status} (install Rust or set ${EXPLORE_BIN_ENV})`,
  };
}

function checkDirectory(name: string, path: string): Check {
  if (existsSync(path)) {
    return { name, status: 'pass', message: path };
  }
  return { name, status: 'warn', message: `${path} (not created yet)` };
}

type ManagedConfigFormat = 'toml' | 'json';

interface ResolvedManagedConfig {
  path: string;
  displayName: string;
  format: ManagedConfigFormat;
  parsed: Record<string, unknown>;
}

interface ManagedConfigReadError {
  path: string;
  displayName: string;
  error: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getLegacyConfigPath(configPath: string): string {
  return join(dirname(configPath), 'settings.json');
}

function tryParseManagedConfig(
  content: string,
  displayName: string,
  format: ManagedConfigFormat,
): { parsed?: Record<string, unknown>; error?: string } {
  try {
    const raw = format === 'toml' ? parseToml(content) : JSON.parse(content);
    if (!isPlainObject(raw)) {
      return {
        error: `${displayName} root must be a ${format === 'toml' ? 'TOML table' : 'JSON object'}`,
      };
    }
    return { parsed: raw };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : `unknown ${format.toUpperCase()} parse error`,
    };
  }
}

async function readManagedConfig(
  configPath: string,
): Promise<ResolvedManagedConfig | ManagedConfigReadError | null> {
  const candidates: Array<{ path: string; format: ManagedConfigFormat }> = [
    { path: configPath, format: 'toml' },
    { path: getLegacyConfigPath(configPath), format: 'json' },
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    try {
      const content = await readFile(candidate.path, 'utf-8');
      const displayName = basename(candidate.path);
      const parsed = tryParseManagedConfig(content, displayName, candidate.format);
      if (parsed.error) {
        return { path: candidate.path, displayName, error: parsed.error };
      }
      return {
        path: candidate.path,
        displayName,
        format: candidate.format,
        parsed: parsed.parsed!,
      };
    } catch {
      return {
        path: candidate.path,
        displayName: basename(candidate.path),
        error: `cannot read ${basename(candidate.path)}`,
      };
    }
  }

  return null;
}

function extractMcpServerNames(parsed: Record<string, unknown>): string[] {
  const tomlServers = parsed.mcp_servers;
  if (isPlainObject(tomlServers)) {
    return Object.keys(tomlServers);
  }

  const jsonServers = parsed.mcpServers;
  if (isPlainObject(jsonServers)) {
    return Object.keys(jsonServers);
  }

  return [];
}

function hasOmbManagedEntries(parsed: Record<string, unknown>): boolean {
  const developerInstructions = parsed.developer_instructions ?? parsed.developerInstructions;
  return extractMcpServerNames(parsed).some((key) => key.startsWith('omb-') || key.startsWith('omb_'))
    || (typeof developerInstructions === 'string'
      && (developerInstructions.includes('oh-my-codebuddy') || developerInstructions.includes('oh-my-codebuddy')));
}

function extractConfigEnv(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const envBlock = parsed.env;
  return isPlainObject(envBlock) ? envBlock : null;
}

function isJsonNativeProvider(provider: DoctorTargetProvider | undefined): boolean {
  return provider === 'codebuddy' || provider === 'claude';
}

async function checkConfig(
  configPath: string,
  provider?: DoctorTargetProvider,
): Promise<Check> {
  const resolved = await readManagedConfig(configPath);
  if (isJsonNativeProvider(provider)) {
    // JSON-native providers: config.toml is intentionally not generated.
    // Healthy = .omb-config.json exists (means `omb setup` has run at least
    // once). settings.json alone is inconclusive because provider-native CLIs may
    // writes one; we need OMB-side footprint to say "set up".
    const ombConfigPath = join(dirname(configPath), '.omb-config.json');
    if (existsSync(ombConfigPath)) {
      return {
        name: 'Config',
        status: 'pass',
        message: '.omb-config.json present; OMB-managed fields ready',
      };
    }
    // No OMB-managed config yet. A residual codex-format config.toml is a
    // separate bug (user needs to run `omb setup` to migrate + cleanup).
    if (resolved && !('error' in resolved) && resolved.displayName !== 'settings.json') {
      return {
        name: 'Config',
        status: 'warn',
        message: `legacy ${resolved.displayName} still present; run "omb setup --provider ${provider ?? 'codebuddy'}" to migrate OMB-consumed fields into .omb-config.json and remove the TOML`,
      };
    }
    if (resolved && 'error' in resolved && resolved.displayName === 'settings.json') {
      return {
        name: 'Config',
        status: 'fail',
        message: `invalid ${resolved.displayName} (${resolved.error})`,
      };
    }
    if (resolved && resolved.displayName === 'settings.json') {
      return {
        name: 'Config',
        status: 'warn',
        message: 'settings.json exists but no OMB entries yet (expected before first setup; run "omb setup --force" once)',
      };
    }
    return {
      name: 'Config',
      status: 'warn',
      message: '.omb-config.json not found (expected before first setup; run "omb setup --force" once)',
    };
  }

  if (!resolved) {
    return { name: 'Config', status: 'warn', message: 'config.toml not found' };
  }
  if ('error' in resolved) {
    return {
      name: 'Config',
      status: 'fail',
      message: `invalid ${resolved.displayName} (${resolved.error})`,
    };
  }

  if (hasOmbManagedEntries(resolved.parsed)) {
    return { name: 'Config', status: 'pass', message: `${resolved.displayName} has OMB entries` };
  }

  return {
    name: 'Config',
    status: 'warn',
    message: `${resolved.displayName} exists but no OMB entries yet (expected before first setup; run "omb setup --force" once)`,
  };
}

async function checkExploreRouting(
  configPath: string,
  provider?: DoctorTargetProvider,
): Promise<Check> {
  const envValue = process.env[OMB_EXPLORE_CMD_ENV];
  if (typeof envValue === 'string' && !isExploreCommandRoutingEnabled(process.env)) {
    return {
      name: 'Explore routing',
      status: 'warn',
      message:
        'disabled by environment override; enable with USE_OMB_EXPLORE_CMD=1 (or remove the explicit opt-out)',
    };
  }

  // JSON-native providers: env config lives primarily in .omb-config.json (not
  // config.toml). Some users also set `env.USE_OMB_EXPLORE_CMD` inside
  // settings.json directly; respect that too so doctor matches the full set
  // of places a JSON-native user might actually configure explore routing.
  if (isJsonNativeProvider(provider)) {
    const codebuddyHomeDir = dirname(configPath);
    const sources: Array<{ path: string; label: string }> = [
      { path: join(codebuddyHomeDir, '.omb-config.json'), label: '.omb-config.json' },
      { path: join(codebuddyHomeDir, 'settings.json'), label: 'settings.json' },
    ];
    for (const source of sources) {
      if (!existsSync(source.path)) continue;
      try {
        const parsed = JSON.parse(await readFile(source.path, 'utf-8'));
        if (!isPlainObject(parsed)) continue;
        const envMap = isPlainObject(parsed.env) ? parsed.env : null;
        if (!envMap) continue;
        const configuredValue = envMap.USE_OMB_EXPLORE_CMD;
        if (
          typeof configuredValue === 'string' &&
          !isExploreCommandRoutingEnabled({ USE_OMB_EXPLORE_CMD: configuredValue })
        ) {
          return {
            name: 'Explore routing',
            status: 'warn',
            message: `disabled in ${source.label} env; set USE_OMB_EXPLORE_CMD to "1" to restore default explore-first routing`,
          };
        }
      } catch {
        // Unparseable source — skip and fall through to default-enabled pass.
      }
    }
    return {
      name: 'Explore routing',
      status: 'pass',
      message: 'enabled by default',
    };
  }

  const resolved = await readManagedConfig(configPath);
  if (!resolved) {
    return {
      name: 'Explore routing',
      status: 'pass',
      message: 'enabled by default (config.toml not found yet)',
    };
  }
  if ('error' in resolved) {
    return {
      name: 'Explore routing',
      status: 'fail',
      message: `cannot read ${resolved.displayName} for explore routing check`,
    };
  }

  const envBlock = extractConfigEnv(resolved.parsed);
  const configuredValue = envBlock?.USE_OMB_EXPLORE_CMD ?? envBlock?.USE_OMB_EXPLORE_CMD;

  if (
    typeof configuredValue === 'string' &&
    !isExploreCommandRoutingEnabled({ USE_OMB_EXPLORE_CMD: configuredValue })
  ) {
    return {
      name: 'Explore routing',
      status: 'warn',
      message:
        `disabled in ${resolved.displayName} env; set USE_OMB_EXPLORE_CMD to "1" to restore default explore-first routing`,
    };
  }

  return {
    name: 'Explore routing',
    status: 'pass',
    message: 'enabled by default',
  };
}

async function checkPrompts(dir: string): Promise<Check> {
  const expectations = getCatalogExpectations();
  if (!existsSync(dir)) {
    return { name: 'Prompts', status: 'warn', message: 'prompts directory not found' };
  }
  try {
    const files = await readdir(dir);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    if (mdFiles.length >= expectations.promptMin) {
      return { name: 'Prompts', status: 'pass', message: `${mdFiles.length} agent prompts installed` };
    }
    return { name: 'Prompts', status: 'warn', message: `${mdFiles.length} prompts (expected >= ${expectations.promptMin})` };
  } catch {
    return { name: 'Prompts', status: 'fail', message: 'cannot read prompts directory' };
  }
}

async function checkLegacySkillRootOverlap(
  canonicalDir: string,
  providerName: string,
): Promise<Check> {
  const overlap = await detectLegacySkillRootOverlap(canonicalDir);
  if (!overlap.legacyExists) {
    return {
      name: 'Legacy skill roots',
      status: 'pass',
      message: 'no ~/.agents/skills overlap detected',
    };
  }

  if (overlap.sameResolvedTarget) {
    return {
      name: 'Legacy skill roots',
      status: 'pass',
      message:
        `~/.agents/skills links to canonical ${overlap.canonicalDir}; treating both paths as one shared skill root`,
    };
  }

  if (overlap.overlappingSkillNames.length === 0) {
    return {
      name: 'Legacy skill roots',
      status: 'warn',
      message:
        `legacy ~/.agents/skills still exists (${overlap.legacySkillCount} skills) alongside canonical ${overlap.canonicalDir}; remove or archive it if ${providerName} shows duplicate entries`,
    };
  }

  const mismatchMessage = overlap.mismatchedSkillNames.length > 0
    ? `; ${overlap.mismatchedSkillNames.length} differ in SKILL.md content`
    : '';
  return {
    name: 'Legacy skill roots',
    status: 'warn',
    message:
      `${overlap.overlappingSkillNames.length} overlapping skill names between ${overlap.canonicalDir} and ${overlap.legacyDir}${mismatchMessage}; ${providerName} Enable/Disable Skills may show duplicates until ~/.agents/skills is cleaned up`,
  };
}

async function checkSkills(dir: string): Promise<Check> {
  const expectations = getCatalogExpectations();
  if (!existsSync(dir)) {
    return { name: 'Skills', status: 'warn', message: 'skills directory not found' };
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const skillDirs = entries.filter(e => e.isDirectory());
    if (skillDirs.length >= expectations.skillMin) {
      return { name: 'Skills', status: 'pass', message: `${skillDirs.length} skills installed` };
    }
    return { name: 'Skills', status: 'warn', message: `${skillDirs.length} skills (expected >= ${expectations.skillMin})` };
  } catch {
    return { name: 'Skills', status: 'fail', message: 'cannot read skills directory' };
  }
}

function checkAgentsMd(scope: DoctorSetupScope, codebuddyHomeDir: string): Check {
  if (scope === 'user') {
    const userAgentsMd = join(codebuddyHomeDir, 'AGENTS.md');
    if (existsSync(userAgentsMd)) {
      return { name: 'AGENTS.md', status: 'pass', message: `found in ${userAgentsMd}` };
    }
    return {
      name: 'AGENTS.md',
      status: 'warn',
      message: `not found in ${userAgentsMd} (run omb setup --scope user)`,
    };
  }

  const projectAgentsMd = join(process.cwd(), 'AGENTS.md');
  if (existsSync(projectAgentsMd)) {
    return { name: 'AGENTS.md', status: 'pass', message: 'found in project root' };
  }
  return {
    name: 'AGENTS.md',
    status: 'warn',
    message: 'not found in project root (run omb agents-init . or omb setup --scope project)',
  };
}

async function checkMcpServers(
  configPath: string,
  provider?: DoctorTargetProvider,
): Promise<Check> {
  if (isJsonNativeProvider(provider)) {
    // JSON-native providers manage MCP servers via settings.json, not via codex-format
    // `[mcp_servers.*]` TOML sections. Inspect settings.json directly so the
    // check still surfaces "user has MCP servers but none are OMB-managed" as
    // a first-setup warning, consistent with the pre-migration behavior.
    const settingsPath = join(dirname(configPath), 'settings.json');
    if (!existsSync(settingsPath)) {
      return { name: 'MCP Servers', status: 'warn', message: 'settings.json not found' };
    }
    try {
      const raw = await readFile(settingsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) {
        return {
          name: 'MCP Servers',
          status: 'fail',
          message: `invalid settings.json (not an object)`,
        };
      }
      const mcpServers = isPlainObject(parsed.mcpServers) ? parsed.mcpServers : null;
      if (!mcpServers) {
        return {
          name: 'MCP Servers',
          status: 'warn',
          message: 'no MCP servers configured',
        };
      }
      const names = Object.keys(mcpServers);
      const hasOmb = names.some((key) => key.startsWith('omb-') || key.startsWith('omb_'));
      if (hasOmb) {
        return {
          name: 'MCP Servers',
          status: 'pass',
          message: `${names.length} servers configured (OMB present)`,
        };
      }
      if (names.length === 0) {
        return { name: 'MCP Servers', status: 'warn', message: 'no MCP servers configured' };
      }
      return {
        name: 'MCP Servers',
        status: 'warn',
        message: `${names.length} servers but no OMB servers yet (expected before first setup; run "omb setup --force" once)`,
      };
    } catch (err) {
      return {
        name: 'MCP Servers',
        status: 'fail',
        message: `cannot parse settings.json (${err instanceof Error ? err.message : 'unknown error'})`,
      };
    }
  }
  const resolved = await readManagedConfig(configPath);
  if (!resolved) {
    return { name: 'MCP Servers', status: 'warn', message: 'config.toml not found' };
  }
  if ('error' in resolved) {
    return { name: 'MCP Servers', status: 'fail', message: `cannot read ${resolved.displayName}` };
  }

  const serverNames = extractMcpServerNames(resolved.parsed);
  const mcpCount = serverNames.length;
  if (mcpCount === 0) {
    return { name: 'MCP Servers', status: 'warn', message: 'no MCP servers configured' };
  }

  const hasOmb = serverNames.some((key) => key.startsWith('omb-') || key.startsWith('omb_'));
  if (hasOmb) {
    return { name: 'MCP Servers', status: 'pass', message: `${mcpCount} servers configured (OMB present)` };
  }

  return {
    name: 'MCP Servers',
    status: 'warn',
    message: `${mcpCount} servers but no OMB servers yet (expected before first setup; run "omb setup --force" once)`,
  };
}

// Canonical OMB hook events installed by `buildManagedHooksConfig`. Keep in
// sync with `src/config/codebuddy-hooks.ts`.
const OMB_HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
] as const;

async function checkHooks(
  hooksPath: string,
  provider: DoctorTargetProvider,
  pkgRoot: string,
  hooksLegacyFlatPath?: string,
): Promise<Check[]> {
  const displayName = providerDisplayName(provider);
  const results: Check[] = [];

  // Primary check: the canonical hooks file exists, parses, registers all 5
  // OMB events, and every managed entry points at the current pkgRoot's
  // native-hook.js.
  if (!existsSync(hooksPath)) {
    results.push({
      name: 'Hooks',
      status: 'warn',
      message: `${hooksPath} not found (run "omb setup --force")`,
    });
  } else {
    let content: string;
    try {
      content = await readFile(hooksPath, 'utf-8');
    } catch (error) {
      results.push({
        name: 'Hooks',
        status: 'fail',
        message: `cannot read ${hooksPath}: ${String(error)}`,
      });
      return maybeAppendFlatGuard(results, provider, hooksLegacyFlatPath);
    }

    let parsed: { hooks?: Record<string, unknown> };
    try {
      parsed = JSON.parse(content) as { hooks?: Record<string, unknown> };
    } catch (error) {
      results.push({
        name: 'Hooks',
        status: 'fail',
        message: `${hooksPath} is not valid JSON (${String(error)})`,
      });
      return maybeAppendFlatGuard(results, provider, hooksLegacyFlatPath);
    }

    const hooksMap = (parsed.hooks ?? {}) as Record<string, unknown>;
    const missingEvents: string[] = [];
    const staleCommandEvents: string[] = [];
    const expectedCommandFragment = expectedNativeHookCommandFragment(
      pkgRoot,
      provider,
    );

    for (const event of OMB_HOOK_EVENTS) {
      const entries = hooksMap[event];
      if (!Array.isArray(entries) || entries.length === 0) {
        missingEvents.push(event);
        continue;
      }
      const hasOmbManagedEntry = entries.some((entry) =>
        entryPointsAtExpectedCommand(entry, expectedCommandFragment),
      );
      if (!hasOmbManagedEntry) staleCommandEvents.push(event);
    }

    if (missingEvents.length > 0) {
      results.push({
        name: 'Hooks',
        status: 'warn',
        message: `${displayName} hooks missing OMB events: ${missingEvents.join(', ')} (run "omb setup --force")`,
      });
    } else if (staleCommandEvents.length > 0) {
      results.push({
        name: 'Hooks',
        status: 'warn',
        message: `${displayName} hooks present but do not reference current pkgRoot (${pkgRoot}); stale events: ${staleCommandEvents.join(', ')} (run "omb setup --force")`,
      });
    } else {
      results.push({
        name: 'Hooks',
        status: 'pass',
        message: `${OMB_HOOK_EVENTS.length} OMB events registered at ${hooksPath}`,
      });
    }
  }

  return maybeAppendFlatGuard(results, provider, hooksLegacyFlatPath);
}

function expectedNativeHookCommandFragment(
  pkgRoot: string,
  provider: DoctorTargetProvider,
): string {
  const scriptName =
    provider === 'codex'
      ? 'codex-native-hook.js'
      : provider === 'claude'
        ? 'claude-native-hook.js'
        : 'codebuddy-native-hook.js';
  return join(pkgRoot, 'dist', 'scripts', scriptName);
}

function entryPointsAtExpectedCommand(
  entry: unknown,
  expectedCommandFragment: string,
): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const hooksArr = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooksArr)) return false;
  return hooksArr.some((hook) => {
    if (!hook || typeof hook !== 'object') return false;
    const cmd = (hook as { command?: unknown }).command;
    return typeof cmd === 'string' && cmd.includes(expectedCommandFragment);
  });
}

function maybeAppendFlatGuard(
  results: Check[],
  provider: DoctorTargetProvider,
  hooksLegacyFlatPath: string | undefined,
): Check[] {
  // Claude CLI reads hooks exclusively from `<home>/hooks/hooks.json`. A flat
  // `<home>/hooks.json` left behind from an older OMB version (or a user's
  // manual write) is silently ignored, which looks like "OMB hooks don't
  // fire". Doctor should surface that discrepancy as a warning so users can
  // delete the stale flat file.
  if (provider !== 'claude') return results;
  if (!hooksLegacyFlatPath) return results;
  if (!existsSync(hooksLegacyFlatPath)) return results;
  results.push({
    name: 'Hooks (legacy flat path)',
    status: 'warn',
    message: `${hooksLegacyFlatPath} exists but Claude CLI does not read it; delete the file or run "omb uninstall --provider claude && omb setup --provider claude --force"`,
  });
  return results;
}

function checkPromptTriage(): Check {
  try {
    const config = readTriageConfig();

    if (config.status === 'disabled') {
      return {
        name: 'Prompt triage',
        status: 'warn',
        message: `disabled via ${config.path}`,
      };
    }

    if (config.status === 'invalid') {
      return {
        name: 'Prompt triage',
        status: 'warn',
        message: `config file malformed at ${config.path} — fails closed to disabled`,
      };
    }

    const decision = triagePrompt('hello');
    const validLanes = new Set(['HEAVY', 'LIGHT', 'PASS']);
    if (!decision || typeof decision !== 'object' || !validLanes.has(decision.lane)) {
      return {
        name: 'Prompt triage',
        status: 'fail',
        message: `classifier returned unexpected shape (lane: ${String(decision?.lane)})`,
      };
    }

    const sourceLabel = config.status === 'defaulted' ? 'enabled (default)' : 'enabled';
    return {
      name: 'Prompt triage',
      status: 'pass',
      message: `config: ${sourceLabel}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Prompt triage', status: 'fail', message: `module load error — ${msg}` };
  }
}
