/**
 * oh-my-codebuddy CLI
 * Multi-agent orchestration for CodeBuddy CLI
 *
 * This is the thin orchestrator entry point. Heavy logic is delegated to:
 * - command-registry: command descriptors, help generation, dispatch
 * - runtime/bootstrap-context: CLI bootstrap context (process.* isolation)
 * - runtime/launch-pipeline: launch lifecycle (preflight, preLaunch, runCodex, postLaunch)
 * - runtime/cleanup: structured cleanup plans
 * - runtime/errors: unified error classification
 */

import { basename, join } from "path";
import { existsSync, readFileSync } from "fs";
import { setup, SETUP_SCOPES, type SetupScope } from "./setup.js";
import { uninstall } from "./uninstall.js";
import { version } from "./version.js";
import { tmuxHookCommand } from "./tmux-hook.js";
import { hooksCommand } from "./hooks.js";
import { hudCommand } from "../hud/index.js";
import { teamCommand } from "./team.js";
import { ralphCommand } from "./ralph.js";
import { askCommand } from "./ask.js";
import { stateCommand } from "./state.js";
import { adaptCommand } from "./adapt.js";
import { questionCommand } from "./question.js";
import {
  cleanupCommand,
  type CleanupDependencies,
  type CleanupResult,
} from "./cleanup.js";
import { exploreCommand } from "./explore.js";
import { sparkshellCommand } from "./sparkshell.js";
import { agentsInitCommand } from "./agents-init.js";
import { agentsCommand } from "./agents.js";
import { sessionCommand } from "./session-search.js";
import { autoresearchCommand } from "./autoresearch.js";
import { mcpParityCommand } from "./mcp-parity.js";
import {
  CODEBUDDY_BIN,
  CODEBUDDY_BYPASS_FLAG,
  CODEBUDDY_EFFORT_FLAG,
  CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG,
  CODEBUDDY_LEGACY_BYPASS_FLAG,
  HIGH_REASONING_FLAG,
  XHIGH_REASONING_FLAG,
  SPARK_FLAG,
  MADMAX_SPARK_FLAG,
  CONFIG_FLAG,
  LONG_CONFIG_FLAG,
  YOLO_FLAG,
  MADMAX_FLAG,
} from "./constants.js";
import { listModeStateFilesWithScopePreference } from "../mcp/state-paths.js";
import { expandCommandPrompt } from "../commands/index.js";
import { isNativeWindows } from "../team/tmux-session.js";
import { getPackageRoot } from "../utils/package.js";
import { codexConfigPath, rememberOmxLaunchContext } from "../utils/paths.js";
import { formatCliText } from "./brand.js";

// ── Re-exports from runtime modules ────────────────────────────────────────

export { parseTmuxPaneSnapshot, isHudWatchPane, findHudWatchPaneIds } from "../hud/tmux.js";

export {
  normalizeCodexLaunchArgs,
  buildTmuxShellCommand,
  buildTmuxPaneCommand,
  buildWindowsPromptCommand,
  buildTmuxSessionName,
  resolveCodexLaunchPolicy,
  resolveLeaderLaunchPolicyOverride,
  classifyCodexExecFailure,
  resolveSignalExitCode,
  buildHudPaneCleanupTargets,
  buildDetachedSessionBootstrapSteps,
  buildDetachedTmuxSessionName,
  buildDetachedSessionFinalizeSteps,
  buildDetachedSessionRollbackSteps,
  resolveNotifyTempContract,
  buildNotifyTempStartupMessages,
  buildNotifyFallbackWatcherEnv,
  shouldEnableNotifyFallbackWatcher,
  reapStaleNotifyFallbackWatcher,
  cleanupLaunchOrphanedMcpProcesses,
  reapPostLaunchOrphanedMcpProcesses,
  cleanupPostLaunchModeStateFiles,
  resolveBackgroundHelperLaunchMode,
  shouldDetachBackgroundHelper,
  resolveNotifyFallbackWatcherScript,
  resolveHookDerivedWatcherScript,
  resolveNotifyHookScript,
  acquireTmuxExtendedKeysLease,
  releaseTmuxExtendedKeysLease,
  withTmuxExtendedKeys,
  collectInheritableTeamWorkerArgs,
  resolveTeamWorkerLaunchArgsEnv,
  injectModelInstructionsBypassArgs,
  resolveWorkerSparkModel,
  resolveCodexHomeForLaunch,
  readPersistedSetupScope,
  readPersistedSetupPreferences,
  resolveSetupScopeArg,
  readTopLevelTomlString,
  upsertTopLevelTomlString,
  launchWithHud,
  execWithOverlay,
  buildWindowsMsysBackgroundHelperBootstrapScript,
  DetachedSessionTmuxStep,
  CodexLaunchPolicy,
  CodexExecFailureClassification,
} from "./runtime/launch-pipeline.js";

export { buildCommandRegistry, CommandRegistry, type CommandDescriptor, type CommandResult, type CliContext } from "./command-registry.js";
export { buildBootstrapContext, type CliBootstrapContext } from "./runtime/bootstrap-context.js";
export { CleanupPlan, type CleanupAction, type CleanupResult as CleanupPlanResult } from "./runtime/cleanup.js";
export { classifyCliError, type CliErrorKind, type ClassifiedError } from "./runtime/errors.js";

// Import from launch-pipeline for local use (not re-export)
import {
  launchWithHud,
  execWithOverlay,
  resolveSetupScopeArg,
  readTopLevelTomlString,
  upsertTopLevelTomlString,
} from "./runtime/launch-pipeline.js";

export { commandOwnsLocalHelp } from "./command-registry.js";
import { commandOwnsLocalHelp } from "./command-registry.js";

// ── Module-level initialization ────────────────────────────────────────────

rememberOmxLaunchContext();

// ── Constants ──────────────────────────────────────────────────────────────

const REASONING_KEY = "model_reasoning_effort";
const TEAM_WORKER_LAUNCH_ARGS_ENV = "OMX_TEAM_WORKER_LAUNCH_ARGS";
const TEAM_INHERIT_LEADER_FLAGS_ENV = "OMX_TEAM_INHERIT_LEADER_FLAGS";
const OMX_RALPH_APPEND_INSTRUCTIONS_FILE_ENV = "OMX_RALPH_APPEND_INSTRUCTIONS_FILE";
const OMX_AUTORESEARCH_APPEND_INSTRUCTIONS_FILE_ENV = "OMX_AUTORESEARCH_APPEND_INSTRUCTIONS_FILE";
const REASONING_MODES = ["low", "medium", "high", "xhigh"] as const;
type ReasoningMode = (typeof REASONING_MODES)[number];
const REASONING_MODE_SET = new Set<string>(REASONING_MODES);
function getReasoningUsage(): string {
  return formatCliText("Usage: {cmd} reasoning <low|medium|high|xhigh>");
}

// ── CLI invocation resolution ──────────────────────────────────────────────

type CliCommand =
  | "launch" | "exec" | "setup" | "agents" | "agents-init" | "deepinit"
  | "uninstall" | "doctor" | "cleanup" | "ask" | "adapt" | "question" | "explore" | "sparkshell"
  | "team" | "session" | "resume" | "version" | "tmux-hook" | "hooks"
  | "hud" | "state" | "status" | "cancel" | "help" | "reasoning" | string;

export interface ResolvedCliInvocation {
  command: CliCommand;
  launchArgs: string[];
}

export function resolveCliInvocation(args: string[]): ResolvedCliInvocation {
  const firstArg = args[0];
  if (firstArg === "--help" || firstArg === "-h") return { command: "help", launchArgs: [] };
  if (firstArg === "--version" || firstArg === "-v") return { command: "version", launchArgs: [] };
  if (!firstArg || firstArg.startsWith("--")) return { command: "launch", launchArgs: firstArg ? args : [] };
  if (firstArg === "launch") return { command: "launch", launchArgs: args.slice(1) };
  if (firstArg === "exec") return { command: "exec", launchArgs: args.slice(1) };
  if (firstArg === "resume") return { command: "resume", launchArgs: args.slice(1) };
  return { command: firstArg, launchArgs: [] };
}

export async function resolveCommandTemplateLaunchPrompt(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  const command = args[0];
  if (!command || command.startsWith("-")) return undefined;
  return expandCommandPrompt(command, args.slice(1), {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
  });
}

// commandOwnsLocalHelp is imported above and re-exported for backward compat

const NESTED_HELP_COMMANDS = new Set<CliCommand>([
  "ask", "adapt", "question", "cleanup", "autoresearch", "agents", "agents-init", "deepinit",
  "exec", "hooks", "hud", "state", "ralph", "resume", "session",
  "sparkshell", "team", "tmux-hook",
]);

// ── Help text ──────────────────────────────────────────────────────────────

function getHelp(): string {
  return formatCliText(`
{project} ({cmd}) - Multi-agent orchestration for {product} CLI

Usage:
  {cmd}           Launch {product} CLI (HUD auto-attaches only when already inside tmux)
  {cmd} exec      Run codebuddy exec non-interactively with {acronym} AGENTS/overlay injection
  {cmd} setup     Install skills, prompts, MCP servers, and scope-specific AGENTS.md
  {cmd} uninstall Remove {acronym} configuration and clean up installed artifacts
  {cmd} doctor    Check installation health
  {cmd} cleanup   Kill orphaned {acronym} MCP server processes and remove stale .omb /tmp directories
  {cmd} doctor --team  Check team/swarm runtime health diagnostics
  {cmd} ask       Ask local provider CLI (claude|gemini) and write artifact output
  {cmd} adapt     Scaffold OMB-owned adapter foundations for persistent external targets
  {cmd} question  Blocking question entrypoint for controlled user questions
  {cmd} resume    Resume a previous interactive {product} session
  {cmd} explore   Default read-only exploration entrypoint (may adaptively use sparkshell backend)
  {cmd} session   Search prior local session transcripts and history artifacts
  {cmd} agents-init [path]
                Bootstrap lightweight AGENTS.md files for a repo/subtree
  {cmd} agents    Manage {product} native agent TOML files
  {cmd} deepinit [path]
                Alias for agents-init (lightweight AGENTS bootstrap only)
  {cmd} team      Spawn parallel worker panes in tmux and bootstrap inbox/task state
  {cmd} ralph     Launch {product} with ralph persistence mode active
  {cmd} autoresearch Launch thin-supervisor autoresearch with keep/discard/reset parity
  {cmd} version   Show version information
  {cmd} tmux-hook Manage tmux prompt injection workaround (init|status|validate|test)
  {cmd} hooks     Manage hook plugins (init|status|validate|test)
  {cmd} hud       Show HUD statusline (--watch, --json, --preset=NAME)
  {cmd} state     Read/write/list {acronym} mode state via CLI parity surface
  {cmd} notepad   CLI parity for {acronym} notepad MCP tools
  {cmd} project-memory
                CLI parity for {acronym} project-memory MCP tools
  {cmd} trace     CLI parity for {acronym} trace MCP tools
  {cmd} code-intel
                CLI parity for {acronym} code-intel MCP tools
  {cmd} sparkshell <command> [args...]
  {cmd} sparkshell --tmux-pane <pane-id> [--tail-lines <100-1000>]
                Run native sparkshell sidecar for direct command execution or explicit tmux-pane summarization
                (also used as an adaptive backend for qualifying read-only explore tasks)
  {cmd} help      Show this help message
  {cmd} status    Show active modes and state
  {cmd} cancel    Cancel active execution modes
  {cmd} reasoning Show or set model reasoning effort (low|medium|high|xhigh)

Options:
  --yolo        Launch {product} in yolo mode (shorthand for: {cmd} launch --yolo)
  --high        Launch {product} with high reasoning effort
                (shorthand for: --effort high)
  --xhigh       Launch {product} with xhigh reasoning effort
                (shorthand for: --effort xhigh)
  --madmax      DANGEROUS: bypass {product} approvals and sandbox
                (alias for --dangerously-skip-permissions)
  --spark       Use the {product} spark model (~1.3x faster) for team workers only
                Workers get the configured low-complexity team model; leader model unchanged
  --madmax-spark  spark model for workers + bypass approvals for leader and workers
                (shorthand for: --spark --madmax)
  --notify-temp  Enable temporary notification routing for this run/session only
  --tmux         Launch the interactive leader session in detached tmux
  --discord      Select Discord provider for temporary notification mode
  --slack        Select Slack provider for temporary notification mode
  --telegram     Select Telegram provider for temporary notification mode
  --custom <name>
                Select custom/OpenClaw gateway name for temporary notification mode
  -w, --worktree[=<name>]
                Launch {product} in a git worktree (detached when no name is given)
  --force       Force reinstall (overwrite existing files)
  --dry-run     Show what would be done without doing it
  --keep-config Skip settings.json cleanup during uninstall
  --purge       Remove .omb/ cache directory during uninstall
  --verbose     Show detailed output
  --scope       Setup scope for "{cmd} setup" only:
                user | project
`);
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function main(args: string[]): Promise<void> {
  const knownCommands = new Set([
    "launch", "exec", "setup", "agents", "agents-init", "deepinit",
    "uninstall", "doctor", "cleanup", "ask", "adapt", "question", "autoresearch", "explore",
    "sparkshell", "team", "ralph", "session", "resume", "version",
    "tmux-hook", "hooks", "hud", "state", "status", "cancel", "help",
    "--help", "-h",
  ]);
  const firstArg = args[0];
  const { command, launchArgs } = resolveCliInvocation(args);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const options = {
    force: flags.has("--force"),
    dryRun: flags.has("--dry-run"),
    verbose: flags.has("--verbose"),
    team: flags.has("--team"),
  };

  if (flags.has("--help") && !commandOwnsLocalHelp(command)) {
    console.log(getHelp());
    return;
  }

  try {
    switch (command) {
      case "launch":
        await launchWithHud(launchArgs);
        break;
      case "resume":
        await launchWithHud(["resume", ...launchArgs]);
        break;
      case "setup":
        await setup({
          force: options.force,
          dryRun: options.dryRun,
          verbose: options.verbose,
          scope: resolveSetupScopeArg(args.slice(1)),
        });
        break;
      case "agents":
        await agentsCommand(args.slice(1));
        break;
      case "agents-init":
        await agentsInitCommand(args.slice(1));
        break;
      case "deepinit":
        await agentsInitCommand(args.slice(1));
        break;
      case "uninstall":
        await uninstall({
          dryRun: options.dryRun,
          keepConfig: flags.has("--keep-config"),
          verbose: options.verbose,
          purge: flags.has("--purge"),
          scope: resolveSetupScopeArg(args.slice(1)),
        });
        break;
      case "doctor": {
        const { doctor } = await import("./doctor.js");
        await doctor(options);
        break;
      }
      case "ask":
        await askCommand(args.slice(1));
        break;
      case "adapt":
        await adaptCommand(args.slice(1));
        break;
      case "question":
        await questionCommand(args.slice(1));
        break;
      case "cleanup":
        await cleanupCommand(args.slice(1));
        break;
      case "autoresearch":
        await autoresearchCommand(args.slice(1));
        break;
      case "explore":
        await exploreCommand(args.slice(1));
        break;
      case "exec":
        await execWithOverlay(launchArgs);
        break;
      case "sparkshell":
        await sparkshellCommand(args.slice(1));
        break;
      case "team":
        await teamCommand(args.slice(1), options);
        break;
      case "session":
        await sessionCommand(args.slice(1));
        break;
      case "ralph":
        await ralphCommand(args.slice(1));
        break;
      case "version":
        version();
        break;
      case "hud":
        await hudCommand(args.slice(1));
        break;
      case "state":
        await stateCommand(args.slice(1));
        break;
      case "notepad":
        await mcpParityCommand("notepad", args.slice(1));
        break;
      case "project-memory":
        await mcpParityCommand("project-memory", args.slice(1));
        break;
      case "trace":
        await mcpParityCommand("trace", args.slice(1));
        break;
      case "code-intel":
        await mcpParityCommand("code-intel", args.slice(1));
        break;
      case "tmux-hook":
        await tmuxHookCommand(args.slice(1));
        break;
      case "hooks":
        await hooksCommand(args.slice(1));
        break;
      case "status":
        await showStatus();
        break;
      case "cancel":
        await cancelModes();
        break;
      case "reasoning":
        await reasoningCommand(args.slice(1));
        break;
      case "help":
      case "--help":
      case "-h":
        console.log(getHelp());
        break;
      default:
        if (firstArg && firstArg.startsWith("-") && !knownCommands.has(firstArg)) {
          await launchWithHud(args);
          break;
        }
        const commandTemplatePrompt = await resolveCommandTemplateLaunchPrompt(args);
        if (commandTemplatePrompt) {
          await launchWithHud([commandTemplatePrompt]);
          break;
        }
        console.error(`Unknown command: ${command}`);
        console.log(getHelp());
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// ── Status command ─────────────────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const { readFile } = await import("fs/promises");
  const cwd = process.cwd();
  try {
    const refs = await listModeStateFilesWithScopePreference(cwd);
    const states = refs.map((ref) => ref.path);
    if (states.length === 0) {
      console.log("No active modes.");
      return;
    }
    for (const path of states) {
      const content = await readFile(path, "utf-8");
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(content) as Record<string, unknown>;
      } catch (err) {
        process.stderr.write(`[cli/index] operation failed: ${err}\n`);
        continue;
      }
      const file = basename(path);
      const mode = file.replace("-state.json", "");
      console.log(`${mode}: ${state.active === true ? "ACTIVE" : "inactive"} (phase: ${String(state.current_phase || "n/a")})`);
    }
  } catch (err) {
    process.stderr.write(`[cli/index] operation failed: ${err}\n`);
    console.log("No active modes.");
  }
}

// ── Reasoning command ──────────────────────────────────────────────────────

async function reasoningCommand(args: string[]): Promise<void> {
  const mode = args[0];
  const configPath = codexConfigPath();

  if (!mode) {
    if (!existsSync(configPath)) {
      console.log(`model_reasoning_effort is not set (${configPath} does not exist).`);
      console.log(getReasoningUsage());
      return;
    }
    const { readFile } = await import("fs/promises");
    const content = await readFile(configPath, "utf-8");
    const current = readTopLevelTomlString(content, REASONING_KEY);
    if (current) {
      console.log(`Current ${REASONING_KEY}: ${current}`);
      return;
    }
    console.log(`${REASONING_KEY} is not set in ${configPath}.`);
    console.log(getReasoningUsage());
    return;
  }

  if (!REASONING_MODE_SET.has(mode)) {
    throw new Error(`Invalid reasoning mode "${mode}". Expected one of: ${REASONING_MODES.join(", ")}.\n${getReasoningUsage()}`);
  }

  const { mkdir, readFile, writeFile } = await import("fs/promises");
  const { dirname } = await import("path");
  await mkdir(dirname(configPath), { recursive: true });
  const existing = existsSync(configPath) ? await readFile(configPath, "utf-8") : "";
  const updated = upsertTopLevelTomlString(existing, REASONING_KEY, mode);
  await writeFile(configPath, updated);
  console.log(`Set ${REASONING_KEY}="${mode}" in ${configPath}`);
}

// ── Cancel command ─────────────────────────────────────────────────────────

async function cancelModes(): Promise<void> {
  const { writeFile, readFile } = await import("fs/promises");
  const cwd = process.cwd();
  const nowIso = new Date().toISOString();
  try {
    const refs = await listModeStateFilesWithScopePreference(cwd);
    const states = new Map<string, { path: string; scope: "root" | "session"; state: Record<string, unknown> }>();
    for (const ref of refs) {
      const content = await readFile(ref.path, "utf-8");
      let parsedState: Record<string, unknown>;
      try { parsedState = JSON.parse(content) as Record<string, unknown>; } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); continue; }
      states.set(ref.mode, { path: ref.path, scope: ref.scope, state: parsedState });
    }
    const changed = new Set<string>();
    const reported = new Set<string>();
    const cancelMode = (mode: string, phase: string = "cancelled", reportIfWasActive: boolean = true): void => {
      const entry = states.get(mode);
      if (!entry) return;
      const wasActive = entry.state.active === true;
      const needsChange = entry.state.active !== false || entry.state.current_phase !== phase || typeof entry.state.completed_at !== "string" || String(entry.state.completed_at).trim() === "";
      if (!needsChange) return;
      entry.state.active = false;
      entry.state.current_phase = phase;
      entry.state.completed_at = nowIso;
      entry.state.last_turn_at = nowIso;
      changed.add(mode);
      if (reportIfWasActive && wasActive) reported.add(mode);
    };
    const ralphLinksUltrawork = (state: Record<string, unknown>): boolean => state.linked_ultrawork === true || state.linked_mode === "ultrawork";
    const ralph = states.get("ralph");
    const hadActiveRalph = !!(ralph && ralph.state.active === true);
    if (ralph && ralph.state.active === true) {
      cancelMode("ralph", "cancelled", true);
      if (ralphLinksUltrawork(ralph.state)) cancelMode("ultrawork", "cancelled", true);
    }
    if (!hadActiveRalph) {
      for (const [mode, entry] of states.entries()) {
        if (entry.state.active === true) cancelMode(mode, "cancelled", true);
      }
    }
    for (const [mode, entry] of states.entries()) {
      if (!changed.has(mode)) continue;
      await writeFile(entry.path, JSON.stringify(entry.state, null, 2));
    }
    for (const mode of reported) console.log(`Cancelled: ${mode}`);
    if (reported.size === 0) console.log("No active modes to cancel.");
  } catch (err) {
    process.stderr.write(`[cli/index] operation failed: ${err}\n`);
    console.log("No active modes to cancel.");
  }
}
