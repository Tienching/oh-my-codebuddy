import { execFileSync, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { ensureWorktree, planWorktreeTarget } from '../team/worktree.js';
import { loadAutoresearchMissionContract } from '../autoresearch/contracts.js';
import {
  countTrailingAutoresearchNoops,
  finalizeAutoresearchRunState,
  loadAutoresearchRunManifest,
  materializeAutoresearchMissionToWorktree,
  prepareAutoresearchRuntime,
  processAutoresearchCandidate,
  resumeAutoresearchRuntime,
  buildAutoresearchRunTag,
} from '../autoresearch/runtime.js';
import { assertModeStartAllowed } from '../modes/base.js';
import {
  buildAutoresearchDeepInterviewPrompt,
  initAutoresearchMission,
  materializeAutoresearchDeepInterviewResult,
  parseInitArgs,
} from './autoresearch-guided.js';
import {
  listAutoresearchDeepInterviewDraftPaths,
  listAutoresearchDeepInterviewResultPaths,
  resolveAutoresearchDeepInterviewResult,
} from './autoresearch-intake.js';
import {
  CODEBUDDY_LEGACY_BYPASS_FLAG,
  CODEBUDDY_BIN,
  CODEX_BIN,
  CODEBUDDY_BYPASS_FLAG,
  CODEBUDDY_EFFORT_FLAG,
  CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG,
  CONFIG_FLAG,
  LONG_CONFIG_FLAG,
  MADMAX_FLAG,
} from './constants.js';
import { restoreStandaloneHudPane, enableMouseScrolling } from '../team/tmux-session.js';
import { resolveOmbCliEntryPath } from '../utils/paths.js';
import { formatCliText } from './brand.js';
import {
  extractLeaderCliArgs,
  normalizeLeaderLaunchArgs,
  translateLeaderExecArgs,
  resolveCodexHomeForLaunch,
  type LeaderCli,
} from './runtime/launch-pipeline.js';

export function getAutoresearchHelp(): string {
  return formatCliText(`{cmd} autoresearch - Launch {acronym} autoresearch with thin-supervisor parity semantics

Usage:
  {cmd} autoresearch                                                (human entrypoint: launch selected leader CLI deep-interview intake, then execute)
  {cmd} autoresearch [--topic T] [--evaluator CMD] [--keep-policy P] [--slug S]
  {cmd} autoresearch init [--topic T] [--evaluator CMD] [--keep-policy P] [--slug S]
  {cmd} autoresearch run <mission-dir> [leader-cli-args...]         (agent/explicit execution entrypoint)
  {cmd} autoresearch <mission-dir> [leader-cli-args...]             (compatibility alias for run)
  {cmd} autoresearch --resume <run-id> [leader-cli-args...]

Arguments:
  --leader-cli C   Select leader CLI runtime for intake and turns: codebuddy (default) | codex
                   (--cli is kept as a compatibility alias).
  (no args)        Launch an interactive selected-CLI session that activates deep-interview --autoresearch,
                   writes .omb/specs artifacts, then launches only after explicit confirmation.
  --topic/...      Seed the deep-interview intake with draft values; still requires refinement/confirmation before launch.
  init             Bare init is an interactive deep-interview alias on TTYs; init with flags is the expert scaffold path.
  run              Execute a crystallized autoresearch mission, preferring tmux split-pane launch when available.
  <mission-dir>    Directory inside a git repository containing mission.md and sandbox.md
  <run-id>         Existing autoresearch run id from .omb/logs/autoresearch/<run-id>/manifest.json

Behavior:
  - deep-interview intake writes canonical artifacts under .omb/specs before launch
  - validates mission.md and sandbox.md
  - requires sandbox.md YAML frontmatter with evaluator.command and evaluator.format=json
  - fresh launch creates a run-tagged autoresearch/<slug>/<run-tag> lane
  - supervisor records baseline, candidate, keep/discard/reset, and results artifacts under .omb/logs/autoresearch/
  - run prefers interview|autoresearch split-pane launch inside tmux, with foreground fallback on failure
  - --resume loads the authoritative per-run manifest and continues from the last kept commit
`);
}

const AUTORESEARCH_APPEND_INSTRUCTIONS_ENV = 'OMB_AUTORESEARCH_APPEND_INSTRUCTIONS_FILE';
const AUTORESEARCH_MAX_CONSECUTIVE_NOOPS = 3;
const REASONING_KEY = 'model_reasoning_effort';
const MODEL_INSTRUCTIONS_FILE_KEY = 'model_instructions_file';

function buildAutoresearchDeepInterviewAppendix(): string {
  return [
    '<autoresearch_deep_interview_mode>',
    'You are in OMB autoresearch intake mode.',
    'Run the deep-interview skill in autoresearch mode and clarify the research mission before launch.',
    'Do not start tmux, do not launch `omb autoresearch`, and do not bypass the user confirmation boundary.',
    'When the user confirms launch and the evaluator is concrete, persist canonical artifacts under `.omb/specs/` using the contracts in `src/cli/autoresearch-intake.ts`.',
    '- Required outputs: `deep-interview-autoresearch-{slug}.md`, `autoresearch-{slug}/mission.md`, `autoresearch-{slug}/sandbox.md`, `autoresearch-{slug}/result.json`.',
    '- If the evaluator is still a placeholder or the user wants to refine further, keep interviewing instead of finalizing launch-ready output.',
    '</autoresearch_deep_interview_mode>',
  ].join('\n');
}

async function writeAutoresearchDeepInterviewAppendixFile(repoRoot: string): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = join(repoRoot, '.omb', 'autoresearch');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'deep-interview-session-instructions.md');
  await writeFile(path, `${buildAutoresearchDeepInterviewAppendix()}\n`, 'utf-8');
  return path;
}

async function runGuidedAutoresearchDeepInterview(
  repoRoot: string,
  seedArgs?: ReturnType<typeof parseInitArgs>,
  leaderCli: LeaderCli = 'codebuddy',
): Promise<Awaited<ReturnType<typeof initAutoresearchMission>>> {
  const previousInstructionsFile = process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV];
  const appendixPath = await writeAutoresearchDeepInterviewAppendixFile(repoRoot);
  const existingResultPaths = new Set(await listAutoresearchDeepInterviewResultPaths(repoRoot));
  const existingDraftPaths = new Set(await listAutoresearchDeepInterviewDraftPaths(repoRoot));
  process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV] = appendixPath;

  try {
    const { launchWithHud } = await import('./index.js');
    await launchWithHud(['--leader-cli', leaderCli, buildAutoresearchDeepInterviewPrompt(seedArgs ?? {})]);
  } finally {
    if (typeof previousInstructionsFile === 'string') {
      process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV] = previousInstructionsFile;
    } else {
      delete process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV];
    }
  }

  const result = await resolveAutoresearchDeepInterviewResult(repoRoot, {
    excludeResultPaths: existingResultPaths,
    excludeDraftPaths: existingDraftPaths,
  });
  if (!result) {
    throw new Error('autoresearch deep-interview did not produce .omb/specs launch artifacts.');
  }
  if (!result.launchReady) {
    throw new Error(
      `autoresearch deep-interview exited without a launch-ready result. ${result.blockedReasons.join(' ') || 'Refine the interview result and retry.'}`,
    );
  }
  return materializeAutoresearchDeepInterviewResult(result);
}

export function normalizeAutoresearchCodeBuddyArgs(codebuddyArgs: readonly string[]): string[] {
  const normalized: string[] = [];
  let hasBypass = false;

  for (let index = 0; index < codebuddyArgs.length; index++) {
    const arg = codebuddyArgs[index];
    if (arg === MADMAX_FLAG || arg === CODEBUDDY_LEGACY_BYPASS_FLAG) {
      if (!hasBypass) {
        normalized.push(CODEBUDDY_BYPASS_FLAG);
        hasBypass = true;
      }
      continue;
    }
    if (arg === CODEBUDDY_BYPASS_FLAG) {
      if (!hasBypass) {
        normalized.push(arg);
        hasBypass = true;
      }
      continue;
    }
    if (arg === CONFIG_FLAG || arg === LONG_CONFIG_FLAG) {
      const next = codebuddyArgs[index + 1];
      if (typeof next === 'string') {
        const match = next.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/);
        const key = match?.[1];
        const value = match?.[2]?.replace(/^["']|["']$/g, '');
        if (key === REASONING_KEY && value && ['low', 'medium', 'high', 'xhigh'].includes(value)) {
          normalized.push(CODEBUDDY_EFFORT_FLAG, value);
        } else if (key === MODEL_INSTRUCTIONS_FILE_KEY && value) {
          normalized.push(CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG, value);
        } else {
          process.stderr.write(`[omb] warning: dropped Codex-only autoresearch CLI argument for CodeBuddy: ${arg} ${next}\n`);
        }
        index += 1;
        continue;
      }
      process.stderr.write(`[omb] warning: dropped Codex-only autoresearch CLI argument for CodeBuddy: ${arg}\n`);
      continue;
    }
    if (arg.startsWith(`${LONG_CONFIG_FLAG}=`)) {
      const raw = arg.slice(`${LONG_CONFIG_FLAG}=`.length);
      const match = raw.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/);
      const key = match?.[1];
      const value = match?.[2]?.replace(/^["']|["']$/g, '');
      if (key === REASONING_KEY && value && ['low', 'medium', 'high', 'xhigh'].includes(value)) {
        normalized.push(CODEBUDDY_EFFORT_FLAG, value);
      } else if (key === MODEL_INSTRUCTIONS_FILE_KEY && value) {
        normalized.push(CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG, value);
      } else {
        process.stderr.write(`[omb] warning: dropped Codex-only autoresearch CLI argument for CodeBuddy: ${arg}\n`);
      }
      continue;
    }
    normalized.push(arg);
  }

  if (!hasBypass) {
    normalized.push(CODEBUDDY_BYPASS_FLAG);
  }

  return normalized;
}

export function normalizeAutoresearchCodexArgs(codebuddyArgs: readonly string[]): string[] {
  return normalizeAutoresearchCodeBuddyArgs(codebuddyArgs);
}

function normalizeAutoresearchLeaderArgs(leaderCli: LeaderCli, args: string[]): string[] {
  if (leaderCli === 'codebuddy') return normalizeAutoresearchCodeBuddyArgs(args);
  const normalized = normalizeLeaderLaunchArgs(args, leaderCli);
  return normalized.includes(CODEBUDDY_LEGACY_BYPASS_FLAG)
    ? normalized
    : [...normalized, CODEBUDDY_LEGACY_BYPASS_FLAG];
}

function resolveAutoresearchLeaderHomeEnv(leaderCli: LeaderCli, cwd: string): NodeJS.ProcessEnv {
  const home = resolveCodexHomeForLaunch(cwd, process.env, leaderCli);
  if (!home) return {};
  return leaderCli === 'codex' ? { CODEX_HOME: home } : { CODEBUDDY_HOME: home };
}

function runAutoresearchTurn(
  worktreePath: string,
  instructionsFile: string,
  codebuddyArgs: string[],
  leaderCli: LeaderCli,
): void {
  const prompt = readFileSync(instructionsFile, 'utf-8');
  const normalizedArgs = normalizeAutoresearchLeaderArgs(leaderCli, codebuddyArgs);
  const launchArgs = translateLeaderExecArgs([...normalizedArgs, prompt], leaderCli);
  const leaderHomeEnv = resolveAutoresearchLeaderHomeEnv(leaderCli, worktreePath);
  const launchEnv: NodeJS.ProcessEnv = { ...process.env, ...leaderHomeEnv, OMB_LEADER_CLI: leaderCli };
  if (leaderCli === 'codex') {
    delete launchEnv.CODEBUDDY_HOME;
  } else {
    delete launchEnv.CODEX_HOME;
  }
  const binary = leaderCli === 'codex' ? CODEX_BIN : CODEBUDDY_BIN;
  const result = spawnSync(binary, launchArgs, {
    cwd: worktreePath,
    stdio: ['ignore', 'inherit', 'inherit'],
    encoding: 'utf-8',
    env: launchEnv,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = typeof result.status === 'number' ? result.status : 1;
    throw new Error(`autoresearch_${leaderCli}_exec_failed:${result.status ?? 'unknown'}`);
  }
}

export interface ParsedAutoresearchArgs {
  missionDir: string | null;
  runId: string | null;
  codebuddyArgs: string[];
  leaderCli: LeaderCli;
  guided?: boolean;
  initArgs?: string[];
  seedArgs?: ReturnType<typeof parseInitArgs>;
  runSubcommand?: boolean;
}

function resolveRepoRoot(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

export function parseAutoresearchArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedAutoresearchArgs {
  const leaderCliResult = extractLeaderCliArgs([...args], env);
  const leaderCli = leaderCliResult.leaderCli;
  const values = leaderCliResult.remainingArgs;
  if (values.length === 0) {
    if (!process.stdin.isTTY) {
      throw new Error(`mission-dir is required.\n${getAutoresearchHelp()}`);
    }
    return { missionDir: null, runId: null, codebuddyArgs: [], leaderCli, guided: true };
  }

  const first = values[0];
  if (first === 'init') {
    return { missionDir: null, runId: null, codebuddyArgs: [], leaderCli, guided: true, initArgs: values.slice(1) };
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    return { missionDir: '--help', runId: null, codebuddyArgs: [], leaderCli };
  }
  if (first === '--resume') {
    const runId = values[1]?.trim();
    if (!runId) {
      throw new Error(`--resume requires <run-id>.\n${getAutoresearchHelp()}`);
    }
    return { missionDir: null, runId, codebuddyArgs: values.slice(2), leaderCli };
  }
  if (first.startsWith('--resume=')) {
    const runId = first.slice('--resume='.length).trim();
    if (!runId) {
      throw new Error(`--resume requires <run-id>.\n${getAutoresearchHelp()}`);
    }
    return { missionDir: null, runId, codebuddyArgs: values.slice(1), leaderCli };
  }
  if (first === 'run') {
    const missionDir = values[1]?.trim();
    if (!missionDir) {
      throw new Error(`run requires <mission-dir>.\n${getAutoresearchHelp()}`);
    }
    return { missionDir, runId: null, codebuddyArgs: values.slice(2), leaderCli, runSubcommand: true };
  }
  if (first.startsWith('-')) {
    const seedArgs = parseInitArgs(values);
    return { missionDir: null, runId: null, codebuddyArgs: [], leaderCli, guided: true, seedArgs };
  }
  return { missionDir: first, runId: null, codebuddyArgs: values.slice(1), leaderCli };
}

async function runAutoresearchLoop(
  codebuddyArgs: string[],
  runtime: {
    instructionsFile: string;
    manifestFile: string;
    repoRoot: string;
    worktreePath: string;
  },
  missionDir: string,
  leaderCli: LeaderCli,
): Promise<void> {
  const previousInstructionsFile = process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV];
  const originalCwd = process.cwd();
  process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV] = runtime.instructionsFile;

  try {
    while (true) {
      runAutoresearchTurn(runtime.worktreePath, runtime.instructionsFile, codebuddyArgs, leaderCli);

      const contract = await loadAutoresearchMissionContract(missionDir);
      const { run_id: runId } = JSON.parse(readFileSync(runtime.manifestFile, 'utf-8')) as { run_id: string };
      const manifest = await loadAutoresearchRunManifest(runtime.repoRoot, runId);
      const decision = await processAutoresearchCandidate(contract, manifest, runtime.repoRoot);
      if (decision === 'abort' || decision === 'error') {
        return;
      }
      if (decision === 'noop') {
        const trailingNoops = await countTrailingAutoresearchNoops(manifest.ledger_file);
        if (trailingNoops >= AUTORESEARCH_MAX_CONSECUTIVE_NOOPS) {
          await finalizeAutoresearchRunState(runtime.repoRoot, manifest.run_id, {
            status: 'stopped',
            stopReason: `repeated noop limit reached (${AUTORESEARCH_MAX_CONSECUTIVE_NOOPS})`,
          });
          return;
        }
      }
      process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV] = runtime.instructionsFile;
    }
  } finally {
    process.chdir(originalCwd);
    if (typeof previousInstructionsFile === 'string') {
      process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV] = previousInstructionsFile;
    } else {
      delete process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV];
    }
  }
}

function checkTmuxAvailable(): boolean {
  const result = spawnSync('tmux', ['-V'], { stdio: 'pipe', windowsHide: true });
  return result.status === 0;
}

function tmuxDisplay(target: string, format: string): string | null {
  const result = spawnSync('tmux', ['display-message', '-p', '-t', target, format], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const value = (result.stdout || '').trim();
  return value || null;
}

function listHudWatchPaneIdsInCurrentWindow(currentPaneId?: string): string[] {
  if (!currentPaneId) return [];
  const result = spawnSync(
    'tmux',
    ['list-panes', '-t', currentPaneId, '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}'],
    { encoding: 'utf-8' },
  );
  if (result.error || result.status !== 0) return [];
  return (result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 3)
    .map(([paneId = '', currentCommand = '', startCommand = '']) => ({ paneId, currentCommand, startCommand }))
    .filter((pane) => pane.paneId.startsWith('%'))
    .filter((pane) => pane.paneId !== currentPaneId)
    .filter((pane) => /\bomb\b.*\bhud\b.*--watch/i.test(pane.startCommand || ''))
    .map((pane) => pane.paneId);
}

function launchAutoresearchInSplitPane(args: {
  currentPaneId: string;
  repoRoot: string;
  missionDir: string;
  codebuddyArgs: string[];
  leaderCli: LeaderCli;
}): boolean {
  if (!checkTmuxAvailable()) return false;

  const paneId = tmuxDisplay(args.currentPaneId, '#{pane_id}');
  if (!paneId) return false;
  const sessionName = tmuxDisplay(paneId, '#S');
  const currentCwd = tmuxDisplay(paneId, '#{pane_current_path}') || args.repoRoot;
  const existingHudPaneIds = listHudWatchPaneIdsInCurrentWindow(paneId);

  const ombPath = resolveOmbCliEntryPath();
  if (!ombPath) return false;
  // Re-enter through the CLI entry so the new pane executes immediately
  // instead of recursively taking the split-pane branch again.
  const launchArgs = ['autoresearch', '--leader-cli', args.leaderCli, args.missionDir, ...args.codebuddyArgs];
  const leaderHomeEnv = resolveAutoresearchLeaderHomeEnv(args.leaderCli, args.repoRoot);
  const commandEnvParts = [
    ...Object.entries({ PATH: process.env.PATH || '' }).map(([key, value]) => `${key}=${value}`),
    `OMB_LEADER_CLI=${args.leaderCli}`,
    ...Object.entries(leaderHomeEnv).map(([key, value]) => `${key}=${value}`),
  ];
  const commandParts = [
    'env',
    ...commandEnvParts,
    process.execPath,
    ombPath,
    ...launchArgs,
  ];
  const command = commandParts
    .map((part) => `'${part.replace(/'/g, `'\\''`)}'`)
    .join(' ');

  const split = spawnSync(
    'tmux',
    ['split-window', '-h', '-t', paneId, '-d', '-P', '-F', '#{pane_id}', '-c', currentCwd, command],
    { encoding: 'utf-8' },
  );
  if (split.error || split.status !== 0) {
    return false;
  }

  if (sessionName && process.env.OMB_MOUSE !== '0') {
    enableMouseScrolling(sessionName);
  }
  if (existingHudPaneIds.length === 0) {
    restoreStandaloneHudPane(paneId, currentCwd);
  }
  console.log(`Autoresearch launched in split pane next to interview pane.`);
  return true;
}

async function executeAutoresearchMissionRun(
  missionDir: string,
  codebuddyArgs: string[],
  leaderCli: LeaderCli,
): Promise<void> {
  const contract = await loadAutoresearchMissionContract(missionDir);
  await assertModeStartAllowed('autoresearch', contract.repoRoot);
  const runTag = buildAutoresearchRunTag();
  const plan = planWorktreeTarget({
    cwd: contract.repoRoot,
    scope: 'autoresearch',
    mode: { enabled: true, detached: false, name: contract.missionSlug },
    worktreeTag: runTag,
  });
  const ensured = ensureWorktree(plan);
  if (!ensured.enabled) {
    throw new Error('autoresearch worktree planning unexpectedly disabled');
  }

  const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, ensured.worktreePath);
  const runtime = await prepareAutoresearchRuntime(worktreeContract, contract.repoRoot, ensured.worktreePath, { runTag });
  await runAutoresearchLoop(codebuddyArgs, runtime, worktreeContract.missionDir, leaderCli);
}

export async function autoresearchCommand(args: string[]): Promise<void> {
  const parsed = parseAutoresearchArgs(args);
  if (parsed.missionDir === '--help') {
    console.log(getAutoresearchHelp());
    return;
  }

  if (parsed.guided) {
    const repoRoot = resolveRepoRoot(process.cwd());
    let result;
    if (parsed.initArgs && parsed.initArgs.length > 0) {
      const initOpts = parseInitArgs(parsed.initArgs);
      if (!initOpts.topic || !initOpts.evaluatorCommand || !initOpts.slug) {
        throw new Error(
          'init requires --topic, --evaluator, and --slug flags.\n'
          + 'Optional: --keep-policy (default: score_improvement)\n\n'
          + `${getAutoresearchHelp()}`,
        );
      }
      result = await initAutoresearchMission({
        topic: initOpts.topic,
        evaluatorCommand: initOpts.evaluatorCommand,
        keepPolicy: initOpts.keepPolicy || 'score_improvement',
        slug: initOpts.slug,
        repoRoot,
      });
    } else {
      result = await runGuidedAutoresearchDeepInterview(repoRoot, parsed.seedArgs, parsed.leaderCli);
    }

    const currentPaneId = process.env.TMUX_PANE?.trim();
    if (currentPaneId && launchAutoresearchInSplitPane({
      currentPaneId,
      repoRoot,
      missionDir: result.missionDir,
      codebuddyArgs: [],
      leaderCli: parsed.leaderCli,
    })) {
      return;
    }

    await executeAutoresearchMissionRun(result.missionDir, [], parsed.leaderCli);
    return;
  }

  if (parsed.runId) {
    const repoRoot = resolveRepoRoot(process.cwd());
    await assertModeStartAllowed('autoresearch', repoRoot);
    const manifest = await loadAutoresearchRunManifest(repoRoot, parsed.runId);
    const runtime = await resumeAutoresearchRuntime(repoRoot, parsed.runId);
    await runAutoresearchLoop(parsed.codebuddyArgs, runtime, manifest.mission_dir, parsed.leaderCli);
    return;
  }

  if (parsed.runSubcommand) {
    const repoRoot = resolveRepoRoot(process.cwd());
    const currentPaneId = process.env.TMUX_PANE?.trim();
    if (currentPaneId && launchAutoresearchInSplitPane({
      currentPaneId,
      repoRoot,
      missionDir: parsed.missionDir as string,
      codebuddyArgs: parsed.codebuddyArgs,
      leaderCli: parsed.leaderCli,
    })) {
      return;
    }
  }

  await executeAutoresearchMissionRun(parsed.missionDir as string, parsed.codebuddyArgs, parsed.leaderCli);
}
