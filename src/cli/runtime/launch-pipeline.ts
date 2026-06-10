/**
 * Launch pipeline for the OMB CLI.
 *
 * Splits the launch flow into discrete stages:
 * - preflight: update prompt, star prompt, config repair
 * - prepareWorkspace: worktree setup, session start, overlay generation
 * - openSession: actual launch (direct / detached-tmux / inside-tmux)
 * - postExitCleanup: session end, overlay strip, worktree rollback
 */

import { execFileSync, spawn } from "child_process";
import { basename, dirname, join } from "path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { constants as osConstants } from "os";
import {
  MADMAX_FLAG,
  CODEBUDDY_BIN,
  CODEX_BIN,
  CLAUDE_BIN,
  CODEBUDDY_BYPASS_FLAG,
  CODEBUDDY_EFFORT_FLAG,
  CODEBUDDY_LEGACY_BYPASS_FLAG,
  CODEBUDDY_PRINT_FLAG,
  CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG,
  HIGH_REASONING_FLAG,
  XHIGH_REASONING_FLAG,
  DEPRECATED_HIGH_REASONING_MSG,
  DEPRECATED_XHIGH_REASONING_MSG,
  EFFORT_FLAG,
  SPARK_FLAG,
  MADMAX_SPARK_FLAG,
  CONFIG_FLAG,
  LONG_CONFIG_FLAG,
  YOLO_FLAG,
} from "../constants.js";
import {
  getBaseStateDir,
  getStateDir,
} from "../../mcp/state-paths.js";
import { maybeCheckAndPromptUpdate } from "../update.js";
import { maybePromptGithubStar } from "../star-prompt.js";
import {
  generateOverlay,
  removeSessionModelInstructionsFile,
  resolveSessionOrchestrationMode,
  sessionModelInstructionsPath,
  writeSessionModelInstructionsFile,
} from "../../hooks/agents-overlay.js";
import {
  readSessionState,
  writeSessionStart,
  writeSessionEnd,
  resetSessionMetrics,
} from "../../hooks/session.js";
import {
  buildClientAttachedReconcileHookName,
  buildReconcileHudResizeArgs,
  buildRegisterClientAttachedReconcileArgs,
  buildRegisterResizeHookArgs,
  buildResizeHookName,
  buildResizeHookTarget,
  buildScheduleDelayedHudResizeArgs,
  buildUnregisterClientAttachedReconcileArgs,
  buildUnregisterResizeHookArgs,
  enableMouseScrolling,
  isMsysOrGitBash,
  isNativeWindows,
  isTmuxAvailable,
} from "../../team/tmux-session.js";
import { getPackageRoot } from "../../utils/package.js";
import { codexConfigPath, resolveOmbCliEntryPath } from "../../utils/paths.js";
import { repairConfigIfNeeded } from "../../config/generator.js";
import { HUD_TMUX_HEIGHT_LINES } from "../../hud/constants.js";
import {
  createHudWatchPane as createSharedHudWatchPane,
  killTmuxPane as killSharedTmuxPane,
  listCurrentWindowHudPaneIds,
  parsePaneIdFromTmuxOutput,
} from "../../hud/tmux.js";
import {
  classifySpawnError,
  resolveCommandPathForPlatform,
  spawnPlatformCommandSync,
} from "../../utils/platform-command.js";
import { buildHookEvent } from "../../hooks/extensibility/events.js";
import { dispatchHookEvent } from "../../hooks/extensibility/dispatcher.js";
import {
  collectInheritableTeamWorkerArgs as collectInheritableTeamWorkerArgsShared,
  resolveTeamWorkerLaunchArgs,
  resolveTeamLowComplexityDefaultModel,
} from "../../team/model-contract.js";
import {
  parseWorktreeMode,
  planWorktreeTarget,
  ensureWorktree,
} from "../../team/worktree.js";
import {
  OMB_NOTIFY_TEMP_CONTRACT_ENV,
  parseNotifyTempContractFromArgs,
  serializeNotifyTempContract,
  type NotifyTempContract,
  type ParseNotifyTempContractResult,
} from "../../notifications/temp-contract.js";
import type { CliBootstrapContext } from "./bootstrap-context.js";
import type { ClassifiedError } from "./errors.js";
import { classifyCliError } from "./errors.js";

export type CodexLaunchPolicy = "inside-tmux" | "detached-tmux" | "direct";
export type LeaderCli = "codebuddy" | "codex" | "claude";

export interface LaunchPipelineResult {
  exitCode: number;
  error?: ClassifiedError;
}

// ── Constants ──────────────────────────────────────────────────────────────

const REASONING_KEY = "model_reasoning_effort";
const MODEL_INSTRUCTIONS_FILE_KEY = "model_instructions_file";
const TEAM_WORKER_LAUNCH_ARGS_ENV = "OMB_TEAM_WORKER_LAUNCH_ARGS";
const TEAM_INHERIT_LEADER_FLAGS_ENV = "OMB_TEAM_INHERIT_LEADER_FLAGS";
const LEADER_CLI_FLAG = "--leader-cli";
const LEGACY_LEADER_CLI_FLAG = "--cli";
const LEADER_CLI_ENV = "OMB_LEADER_CLI";
const OMB_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV = "OMB_BYPASS_DEFAULT_SYSTEM_PROMPT";
const OMB_MODEL_INSTRUCTIONS_FILE_ENV = "OMB_MODEL_INSTRUCTIONS_FILE";
const OMB_RALPH_APPEND_INSTRUCTIONS_FILE_ENV = "OMB_RALPH_APPEND_INSTRUCTIONS_FILE";
const OMB_AUTORESEARCH_APPEND_INSTRUCTIONS_FILE_ENV = "OMB_AUTORESEARCH_APPEND_INSTRUCTIONS_FILE";
const CODEBUDDY_NPM_PACKAGE = "@tencent-ai/codebuddy-code";
const CODEBUDDY_AUTO_INSTALL_ENV = "OMB_CODEBUDDY_AUTO_INSTALL";
const REASONING_MODES = ["low", "medium", "high", "xhigh"] as const;
type ReasoningMode = (typeof REASONING_MODES)[number];
const REASONING_MODE_SET = new Set<string>(REASONING_MODES);
const VERSION_FLAGS = new Set(["--version", "-V", "-v"]);
const TMUX_EXTENDED_KEYS_MODE = "always";
const TMUX_EXTENDED_KEYS_FALLBACK_MODE = "off";
const TMUX_EXTENDED_KEYS_LEASE_DIR = "tmux-extended-keys";
const TMUX_EXTENDED_KEYS_LOCK_RETRY_MS = 20;
const TMUX_EXTENDED_KEYS_LOCK_MAX_ATTEMPTS = 100;
const ALLOWED_SHELLS = new Set([
  "/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash", "/bin/fish",
  "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/zsh", "/usr/bin/dash", "/usr/bin/fish",
  "/usr/local/bin/bash", "/usr/local/bin/zsh", "/usr/local/bin/fish",
]);
const WINDOWS_DETACHED_BOOTSTRAP_DELAY_MS = 2500;
const KILL_DETACHED_SESSION_ON_EXIT_ENV = "OMB_KILL_DETACHED_SESSION_ON_EXIT";

// ── Signal / exec error helpers ────────────────────────────────────────────

type ExecFileSyncFailure = NodeJS.ErrnoException & {
  status?: number | null;
  signal?: NodeJS.Signals | null;
};

function hasErrnoCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export function resolveSignalExitCode(signal: NodeJS.Signals | null | undefined): number {
  if (!signal) return 1;
  const signalNumber = osConstants.signals[signal];
  if (typeof signalNumber === "number" && Number.isFinite(signalNumber)) {
    return 128 + signalNumber;
  }
  return 1;
}

export interface CodexExecFailureClassification {
  kind: "exit" | "launch-error";
  code?: string;
  message: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
}

export function classifyCodexExecFailure(error: unknown): CodexExecFailureClassification {
  if (!error || typeof error !== "object") {
    return { kind: "launch-error", message: String(error) };
  }
  const err = error as ExecFileSyncFailure;
  const code = typeof err.code === "string" ? err.code : undefined;
  const message = typeof err.message === "string" && err.message.length > 0
    ? err.message
    : "unknown CodeBuddy launch failure";
  const hasExitStatus = typeof err.status === "number";
  const hasSignal = typeof err.signal === "string" && err.signal.length > 0;
  if (hasExitStatus || hasSignal) {
    return {
      kind: "exit",
      code,
      message,
      exitCode: hasExitStatus ? (err.status as number) : resolveSignalExitCode(err.signal),
      signal: hasSignal ? (err.signal as NodeJS.Signals) : undefined,
    };
  }
  return { kind: "launch-error", code, message };
}

// ── CodeBuddy CLI auto-install ────────────────────────────────────────────

export function shouldAutoInstallCodeBuddy(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CODEBUDDY_AUTO_INSTALL_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return true;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

function isCodeBuddyAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(resolveCommandPathForPlatform(CODEBUDDY_BIN, process.platform, env));
}

export function ensureCodeBuddyAvailable(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isCodeBuddyAvailable(env)) return;
  if (!shouldAutoInstallCodeBuddy(env)) return;

  console.error(`[omb] CodeBuddy CLI not found in PATH. Installing ${CODEBUDDY_NPM_PACKAGE} globally...`);
  const { result } = spawnPlatformCommandSync("npm", ["install", "-g", CODEBUDDY_NPM_PACKAGE], {
    cwd,
    stdio: "inherit",
    env,
    encoding: "utf-8",
  });

  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    const kind = classifySpawnError(errno);
    const installHint = `Install CodeBuddy manually: npm install -g ${CODEBUDDY_NPM_PACKAGE}`;
    if (kind === "missing") throw new Error(`[omb] npm was not found, so CodeBuddy could not be installed. ${installHint}`);
    if (kind === "blocked") throw new Error(`[omb] npm is blocked in this environment (${errno.code || "blocked"}). ${installHint}`);
    throw new Error(`[omb] failed to install CodeBuddy: ${errno.message}. ${installHint}`);
  }
  if (result.status !== 0) {
    throw new Error(`[omb] npm install -g ${CODEBUDDY_NPM_PACKAGE} failed with exit code ${result.status ?? "unknown"}. Install CodeBuddy manually, then retry.`);
  }
  if (!isCodeBuddyAvailable(env)) {
    throw new Error(`[omb] ${CODEBUDDY_NPM_PACKAGE} was installed, but '${CODEBUDDY_BIN}' is still not available in PATH. Add your npm global bin directory to PATH, then retry.`);
  }
}

// ── Leader CLI selection ──────────────────────────────────────────────────

export function parseLeaderCliValue(raw: string | undefined, source: string): LeaderCli {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (normalized === "" && source === LEADER_CLI_ENV) return "codebuddy";
  if (normalized === "codebuddy" || normalized === "codex" || normalized === "claude") {
    return normalized;
  }
  throw new Error(`Invalid ${source} value "${raw ?? ""}". Expected: codebuddy, codex, claude`);
}

function resolveLeaderCliFromEnv(
  env: NodeJS.ProcessEnv,
  defaultLeaderCli: LeaderCli,
): LeaderCli {
  const raw = env[LEADER_CLI_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return defaultLeaderCli;
  return parseLeaderCliValue(raw, LEADER_CLI_ENV);
}

function tryParsePersistedLeaderCli(raw: unknown, source: string): LeaderCli | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return undefined;
  if (normalized === "codebuddy" || normalized === "codex" || normalized === "claude") {
    return normalized;
  }
  process.stderr.write(`[cli/index] operation failed: Invalid ${source} value "${raw}". Expected: codebuddy, codex, claude\n`);
  return undefined;
}

function mapSetupProviderToLeaderCli(provider: SetupProvider | undefined): LeaderCli | undefined {
  if (provider === "codebuddy" || provider === "codex" || provider === "claude") return provider;
  return undefined;
}

function readPersistedResumeLeaderCli(cwd: string): LeaderCli | undefined {
  const sessionStatePath = join(getBaseStateDir(cwd), "session.json");
  if (existsSync(sessionStatePath)) {
    try {
      const parsed = JSON.parse(readFileSync(sessionStatePath, "utf-8")) as { leader_cli?: unknown };
      const persistedSessionCli = tryParsePersistedLeaderCli(parsed.leader_cli, `${sessionStatePath} leader_cli`);
      if (persistedSessionCli) return persistedSessionCli;
    } catch {
      // Ignore malformed or unreadable session state and continue falling back.
    }
  }

  const historyPath = join(cwd, ".omb", "logs", "session-history.jsonl");
  if (existsSync(historyPath)) {
    try {
      const lines = readFileSync(historyPath, "utf-8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line) continue;
        const parsed = JSON.parse(line) as { leader_cli?: unknown };
        const persistedHistoryCli = tryParsePersistedLeaderCli(parsed.leader_cli, `${historyPath} leader_cli`);
        if (persistedHistoryCli) return persistedHistoryCli;
      }
    } catch {
      // Ignore malformed or unreadable history and continue falling back.
    }
  }

  return mapSetupProviderToLeaderCli(readPersistedSetupPreferences(cwd)?.provider);
}

function isLeaderCliFlag(arg: string): boolean {
  return arg === LEADER_CLI_FLAG || arg === LEGACY_LEADER_CLI_FLAG;
}

function splitInlineLeaderCliFlag(arg: string): { flag: string; value: string } | null {
  for (const flag of [LEADER_CLI_FLAG, LEGACY_LEADER_CLI_FLAG]) {
    if (arg.startsWith(`${flag}=`)) {
      return { flag, value: arg.slice(`${flag}=`.length) };
    }
  }
  return null;
}

export function extractLeaderCliArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  defaultLeaderCli: LeaderCli = "codebuddy",
): { leaderCli: LeaderCli; remainingArgs: string[] } {
  let leaderCli = resolveLeaderCliFromEnv(env, defaultLeaderCli);
  const remainingArgs: string[] = [];
  let passthroughOnly = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (passthroughOnly) { remainingArgs.push(arg); continue; }
    if (arg === "--") { passthroughOnly = true; remainingArgs.push(arg); continue; }
    if (isLeaderCliFlag(arg)) {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) throw new Error(`Missing value after ${arg}. Expected: codebuddy, codex, claude`);
      leaderCli = parseLeaderCliValue(next, arg);
      index += 1;
      continue;
    }
    const inlineLeaderCli = splitInlineLeaderCliFlag(arg);
    if (inlineLeaderCli) {
      leaderCli = parseLeaderCliValue(inlineLeaderCli.value, inlineLeaderCli.flag);
      continue;
    }
    remainingArgs.push(arg);
  }

  return { leaderCli, remainingArgs };
}

function resolveLeaderCliBinary(leaderCli: LeaderCli): string {
  switch (leaderCli) {
    case "codebuddy":
      return CODEBUDDY_BIN;
    case "codex":
      return CODEX_BIN;
    case "claude":
      return CLAUDE_BIN;
  }
}

// ── Run codex blocking ─────────────────────────────────────────────────────

function runCodexBlocking(
  cwd: string,
  binary: string,
  launchArgs: string[],
  codexEnv: NodeJS.ProcessEnv,
): void {
  if (binary === CODEBUDDY_BIN) ensureCodeBuddyAvailable(cwd, codexEnv);
  const product = (() => {
    switch (binary) {
      case CODEX_BIN:
        return "codex";
      case CLAUDE_BIN:
        return "claude";
      default:
        return "codebuddy";
    }
  })();
  const { result } = spawnPlatformCommandSync(binary, launchArgs, {
    cwd,
    stdio: "inherit",
    env: codexEnv,
    encoding: "utf-8",
  });
  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    const kind = classifySpawnError(errno);
    if (kind === "missing") {
      console.error(`[omb] failed to launch ${product}: executable not found in PATH`);
    } else if (kind === "blocked") {
      console.error(`[omb] failed to launch ${product}: executable is present but blocked in the current environment (${errno.code || "blocked"})`);
    } else {
      console.error(`[omb] failed to launch ${product}: ${errno.message}`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = typeof result.status === "number"
      ? result.status
      : resolveSignalExitCode(result.signal);
    if (result.signal) {
      console.error(`[omb] ${product} exited due to signal ${result.signal}`);
    }
  }
}

// ── Launch policy ──────────────────────────────────────────────────────────

function splitLeaderLaunchPolicyArgs(args: string[]): {
  explicitPolicy?: CodexLaunchPolicy;
  remainingArgs: string[];
} {
  const remainingArgs: string[] = [];
  let explicitPolicy: CodexLaunchPolicy | undefined;
  let passthroughOnly = false;
  for (const arg of args) {
    if (passthroughOnly) { remainingArgs.push(arg); continue; }
    if (arg === "--") { passthroughOnly = true; remainingArgs.push(arg); continue; }
    if (arg === "--tmux") { explicitPolicy = "detached-tmux"; continue; }
    remainingArgs.push(arg);
  }
  return { explicitPolicy, remainingArgs };
}

export function resolveLeaderLaunchPolicyOverride(args: string[]): CodexLaunchPolicy | undefined {
  return splitLeaderLaunchPolicyArgs(args).explicitPolicy;
}

export function resolveCodexLaunchPolicy(
  env: NodeJS.ProcessEnv = process.env,
  _platform: NodeJS.Platform = process.platform,
  tmuxAvailable: boolean = isTmuxAvailable(),
  nativeWindows: boolean = isNativeWindows(),
  stdinIsTTY: boolean = Boolean(process.stdin.isTTY),
  stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
  explicitPolicy?: CodexLaunchPolicy,
): CodexLaunchPolicy {
  if (env.TMUX) return "inside-tmux";
  if (explicitPolicy === "detached-tmux") return tmuxAvailable ? "detached-tmux" : "direct";
  if (explicitPolicy === "direct") return "direct";
  if (_platform === "win32") return "direct";
  if (nativeWindows) return "direct";
  if (!stdinIsTTY || !stdoutIsTTY) return "direct";
  return tmuxAvailable ? "detached-tmux" : "direct";
}

// ── Arg normalization ──────────────────────────────────────────────────────

function hasExplicitBypassPermissionMode(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--permission-mode" && args[i + 1] === "bypassPermissions") return true;
    if (arg === "--permission-mode=bypassPermissions") return true;
  }
  return false;
}

function isModelInstructionsOverride(value: string): boolean {
  return new RegExp(`^${MODEL_INSTRUCTIONS_FILE_KEY}\\s*=`).test(value.trim());
}

function hasModelInstructionsOverride(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === "string" && maybeValue.trim().length > 0) return true;
      continue;
    }
    if (arg.startsWith(`${CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG}=`)) return true;
    if (arg === CONFIG_FLAG || arg === LONG_CONFIG_FLAG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === "string" && isModelInstructionsOverride(maybeValue)) return true;
      continue;
    }
    if (arg.startsWith(`${LONG_CONFIG_FLAG}=`)) {
      const inlineValue = arg.slice(`${LONG_CONFIG_FLAG}=`.length);
      if (isModelInstructionsOverride(inlineValue)) return true;
    }
  }
  return false;
}

function shouldBypassDefaultSystemPrompt(env: NodeJS.ProcessEnv): boolean {
  const ombValue = env[OMB_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV];
  if (typeof ombValue === "string" && ombValue.trim() !== "") return ombValue !== "0";
  return env[OMB_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV] !== "0";
}

function resolveModelInstructionsFilePath(
  cwd: string,
  env: NodeJS.ProcessEnv,
  defaultFilePath?: string,
): string {
  return env[OMB_MODEL_INSTRUCTIONS_FILE_ENV] || env[OMB_MODEL_INSTRUCTIONS_FILE_ENV] || defaultFilePath || join(cwd, "AGENTS.md");
}

function parseLegacyConfigOverride(rawValue: string):
  | { kind: "system-prompt-file"; value: string }
  | { kind: "reasoning"; value: ReasoningMode }
  | null {
  const match = rawValue.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/);
  if (!match) return null;
  const [, key, encodedValue] = match;
  const value = parseTomlStringValue(encodedValue);
  if (key === MODEL_INSTRUCTIONS_FILE_KEY) return { kind: "system-prompt-file", value };
  if (key === REASONING_KEY && REASONING_MODE_SET.has(value)) return { kind: "reasoning", value: value as ReasoningMode };
  return null;
}

function parseTomlStringValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) return trimmed.slice(1, -1);
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) return trimmed.slice(1, -1);
  return trimmed;
}

function warnDroppedCodexOnlyArg(arg: string): void {
  process.stderr.write(`[omb] warning: dropped Codex-only CLI argument for CodeBuddy: ${arg}\n`);
}

export function normalizeCodexLaunchArgs(args: string[]): string[] {
  const parsed = parseWorktreeMode(args);
  const launchPolicyParsed = splitLeaderLaunchPolicyArgs(parsed.remainingArgs);
  const normalized: string[] = [];
  let wantsBypass = false;
  let hasBypass = false;
  let reasoningMode: ReasoningMode | null = null;
  const deprecationWarnings: string[] = [];

  for (let index = 0; index < launchPolicyParsed.remainingArgs.length; index++) {
    const arg = launchPolicyParsed.remainingArgs[index];
    if (arg === MADMAX_FLAG || arg === YOLO_FLAG || arg === CODEBUDDY_LEGACY_BYPASS_FLAG || arg === CODEBUDDY_BYPASS_FLAG) { wantsBypass = true; continue; }
    // Deprecated --high/--xhigh → map to effort (with warning)
    if (arg === HIGH_REASONING_FLAG) { reasoningMode = "high"; deprecationWarnings.push(DEPRECATED_HIGH_REASONING_MSG); continue; }
    if (arg === XHIGH_REASONING_FLAG) { reasoningMode = "xhigh"; deprecationWarnings.push(DEPRECATED_XHIGH_REASONING_MSG); continue; }
    // --effort <low|medium|high|xhigh> — explicit reasoning effort
    if (arg === EFFORT_FLAG) {
      const next = launchPolicyParsed.remainingArgs[index + 1];
      if (next && REASONING_MODE_SET.has(next)) { reasoningMode = next as ReasoningMode; index += 1; continue; }
      // Invalid or missing value — pass through as-is, CodeBuddy will handle the error
      normalized.push(arg);
      if (next) { normalized.push(next); index += 1; }
      continue;
    }
    if (arg === CONFIG_FLAG || arg === LONG_CONFIG_FLAG) {
      const next = launchPolicyParsed.remainingArgs[index + 1];
      if (typeof next === "string") {
        const translated = parseLegacyConfigOverride(next);
        if (translated?.kind === "system-prompt-file") { normalized.push(CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG, translated.value); index += 1; continue; }
        if (translated?.kind === "reasoning") { reasoningMode = translated.value; index += 1; continue; }
        warnDroppedCodexOnlyArg(`${arg} ${next}`);
        index += 1;
        continue;
      }
      warnDroppedCodexOnlyArg(arg); continue;
    }
    if (arg.startsWith(`${LONG_CONFIG_FLAG}=`)) {
      const translated = parseLegacyConfigOverride(arg.slice(`${LONG_CONFIG_FLAG}=`.length));
      if (translated?.kind === "system-prompt-file") { normalized.push(CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG, translated.value); continue; }
      if (translated?.kind === "reasoning") { reasoningMode = translated.value; continue; }
      warnDroppedCodexOnlyArg(arg); continue;
    }
    if (arg === "--ask-for-approval" || arg === "-a") {
      const next = launchPolicyParsed.remainingArgs[index + 1];
      if (next === "never") {
        wantsBypass = true;
        index += 1;
        continue;
      }
      if (typeof next === "string") {
        warnDroppedCodexOnlyArg(`${arg} ${next}`);
        index += 1;
        continue;
      }
      warnDroppedCodexOnlyArg(arg); continue;
    }
    if (arg.startsWith("--ask-for-approval=")) {
      const value = arg.slice("--ask-for-approval=".length);
      if (value === "never") { wantsBypass = true; continue; }
      warnDroppedCodexOnlyArg(arg); continue;
    }
    if (arg === SPARK_FLAG) continue;
    if (arg === MADMAX_SPARK_FLAG) { wantsBypass = true; continue; }
    normalized.push(arg);
  }
  if (wantsBypass && !hasBypass && !hasExplicitBypassPermissionMode(normalized)) normalized.push(CODEBUDDY_BYPASS_FLAG);
  if (reasoningMode) normalized.push(CODEBUDDY_EFFORT_FLAG, reasoningMode);
  // Emit deprecation warnings to stderr
  for (const warning of deprecationWarnings) {
    process.stderr.write(`[omb] ${warning}\n`);
  }
  return normalized;
}

export function normalizeCodexCliLaunchArgs(args: string[]): string[] {
  const parsed = parseWorktreeMode(args);
  const launchPolicyParsed = splitLeaderLaunchPolicyArgs(parsed.remainingArgs);
  const normalized: string[] = [];
  let wantsBypass = false;
  let hasBypass = false;
  let reasoningMode: ReasoningMode | null = null;
  const deprecationWarnings: string[] = [];

  for (let index = 0; index < launchPolicyParsed.remainingArgs.length; index++) {
    const arg = launchPolicyParsed.remainingArgs[index];
    if (arg === MADMAX_FLAG || arg === YOLO_FLAG || arg === CODEBUDDY_BYPASS_FLAG || arg === MADMAX_SPARK_FLAG) { wantsBypass = true; continue; }
    if (arg === CODEBUDDY_LEGACY_BYPASS_FLAG) { wantsBypass = true; if (!hasBypass) { normalized.push(arg); hasBypass = true; } continue; }
    if (arg === HIGH_REASONING_FLAG) { reasoningMode = "high"; deprecationWarnings.push(DEPRECATED_HIGH_REASONING_MSG); continue; }
    if (arg === XHIGH_REASONING_FLAG) { reasoningMode = "xhigh"; deprecationWarnings.push(DEPRECATED_XHIGH_REASONING_MSG); continue; }
    if (arg === EFFORT_FLAG) {
      const next = launchPolicyParsed.remainingArgs[index + 1];
      if (next && REASONING_MODE_SET.has(next)) { reasoningMode = next as ReasoningMode; index += 1; continue; }
      normalized.push(arg);
      if (next) { normalized.push(next); index += 1; }
      continue;
    }
    if (arg === CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG) {
      const next = launchPolicyParsed.remainingArgs[index + 1];
      if (typeof next === "string" && next.trim() !== "") {
        normalized.push(CONFIG_FLAG, `${MODEL_INSTRUCTIONS_FILE_KEY}="${escapeTomlString(next)}"`);
        index += 1;
        continue;
      }
      normalized.push(arg);
      continue;
    }
    if (arg.startsWith(`${CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG}=`)) {
      const value = arg.slice(`${CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG}=`.length).trim();
      if (value !== "") {
        normalized.push(CONFIG_FLAG, `${MODEL_INSTRUCTIONS_FILE_KEY}="${escapeTomlString(parseTomlStringValue(value))}"`);
        continue;
      }
    }
    if (arg === "--permission-mode" && launchPolicyParsed.remainingArgs[index + 1] === "bypassPermissions") {
      wantsBypass = true;
      index += 1;
      continue;
    }
    if (arg === "--permission-mode=bypassPermissions") { wantsBypass = true; continue; }
    if (arg === SPARK_FLAG) continue;
    normalized.push(arg);
  }

  if (wantsBypass && !hasBypass) normalized.push(CODEBUDDY_LEGACY_BYPASS_FLAG);
  if (reasoningMode) normalized.push(CONFIG_FLAG, `${REASONING_KEY}="${reasoningMode}"`);
  for (const warning of deprecationWarnings) {
    process.stderr.write(`[omb] ${warning}\n`);
  }
  return normalized;
}

export function normalizeClaudeCliLaunchArgs(args: string[]): string[] {
  const parsed = parseWorktreeMode(args);
  const launchPolicyParsed = splitLeaderLaunchPolicyArgs(parsed.remainingArgs);
  const normalized: string[] = [];
  let wantsBypass = false;
  let hasBypass = false;
  // NOTE: claude's `-c` is `--continue` (resume last session), NOT codex's
  // `--config key=value`. Reusing CONFIG_FLAG/MODEL_INSTRUCTIONS_FILE_KEY here
  // (as codex/codebuddy do) makes claude treat `-c` as continue and exit 1
  // with "No deferred tool marker found in the resumed session". Therefore:
  //   - `--system-prompt-file` is dropped (claude auto-reads cwd AGENTS.md/CLAUDE.md)
  //   - `--effort` / `--reasoning-effort` are dropped (claude has no equivalent flag)
  // Both emit a one-line stderr warning so users notice the no-op.
  const deprecationWarnings: string[] = [];
  let droppedSystemPromptFile = false;
  let droppedEffort = false;

  for (let index = 0; index < launchPolicyParsed.remainingArgs.length; index++) {
    const arg = launchPolicyParsed.remainingArgs[index];
    if (arg === MADMAX_FLAG || arg === YOLO_FLAG || arg === MADMAX_SPARK_FLAG) { wantsBypass = true; continue; }
    if (arg === CODEBUDDY_BYPASS_FLAG) {
      if (!hasBypass) {
        normalized.push(arg);
        hasBypass = true;
      }
      continue;
    }
    if (arg === CODEBUDDY_LEGACY_BYPASS_FLAG) { wantsBypass = true; continue; }
    if (arg === HIGH_REASONING_FLAG) { droppedEffort = true; deprecationWarnings.push(DEPRECATED_HIGH_REASONING_MSG); continue; }
    if (arg === XHIGH_REASONING_FLAG) { droppedEffort = true; deprecationWarnings.push(DEPRECATED_XHIGH_REASONING_MSG); continue; }
    if (arg === EFFORT_FLAG) {
      const next = launchPolicyParsed.remainingArgs[index + 1];
      if (next && REASONING_MODE_SET.has(next)) {
        droppedEffort = true;
        index += 1;
        continue;
      }
      // Bare `--effort` with no recognized value: drop the flag (claude has
      // no --effort), advancing past any opaque value to avoid leaking it.
      droppedEffort = true;
      if (next) index += 1;
      continue;
    }
    if (arg === CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG) {
      const next = launchPolicyParsed.remainingArgs[index + 1];
      if (typeof next === "string" && next.trim() !== "") {
        droppedSystemPromptFile = true;
        index += 1;
        continue;
      }
      droppedSystemPromptFile = true;
      continue;
    }
    if (arg.startsWith(`${CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG}=`)) {
      droppedSystemPromptFile = true;
      continue;
    }
    if (arg === "--permission-mode" && launchPolicyParsed.remainingArgs[index + 1] === "bypassPermissions") {
      wantsBypass = true;
      index += 1;
      continue;
    }
    if (arg === "--permission-mode=bypassPermissions") { wantsBypass = true; continue; }
    if (arg === SPARK_FLAG) continue;
    normalized.push(arg);
  }

  if (wantsBypass && !hasBypass) normalized.push(CODEBUDDY_BYPASS_FLAG);
  // Intentionally do NOT emit `-c model_reasoning_effort=...` for claude —
  // see the comment block at the top of this function. Same for
  // `model_instructions_file=...`.
  if (droppedSystemPromptFile) {
    process.stderr.write(`[omb] --system-prompt-file is ignored for claude (claude auto-reads AGENTS.md / CLAUDE.md from cwd)\n`);
  }
  if (droppedEffort) {
    process.stderr.write(`[omb] --effort / reasoning-effort is ignored for claude (claude has no equivalent flag)\n`);
  }
  for (const warning of deprecationWarnings) {
    process.stderr.write(`[omb] ${warning}\n`);
  }
  return normalized;
}

export function normalizeLeaderLaunchArgs(args: string[], leaderCli: LeaderCli): string[] {
  switch (leaderCli) {
    case "codebuddy":
      return normalizeCodexLaunchArgs(args);
    case "codex":
      return normalizeCodexCliLaunchArgs(args);
    case "claude":
      return normalizeClaudeCliLaunchArgs(args);
  }
}

export function translateCodeBuddyResumeArgs(args: string[]): string[] {
  if (args[0] !== "resume") return [...args];
  const rest = args.slice(1);
  const translated: string[] = [];
  let useContinue = false;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--last") {
      useContinue = true;
      continue;
    }
    if (arg === "--all" || arg === "--include-non-interactive") {
      warnDroppedCodexOnlyArg(`resume ${arg}`);
      continue;
    }
    translated.push(arg);
  }

  return [useContinue ? "--continue" : "--resume", ...translated];
}

export function translateCodeBuddyExecArgs(args: string[]): string[] {
  const translated: string[] = [];
  let hasPrint = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === CODEBUDDY_PRINT_FLAG || arg === "-p") {
      hasPrint = true;
      translated.push(arg);
      continue;
    }
    if (arg === "--json") {
      translated.push("--output-format", "stream-json");
      continue;
    }
    if (arg === "--output-schema") {
      const next = args[index + 1];
      if (typeof next === "string") {
        translated.push("--json-schema", next);
        index += 1;
        continue;
      }
      warnDroppedCodexOnlyArg(arg);
      continue;
    }
    if (arg.startsWith("--output-schema=")) {
      translated.push("--json-schema", arg.slice("--output-schema=".length));
      continue;
    }
    if (arg === "--output-last-message" || arg === "-o" || arg === "--color") {
      const next = args[index + 1];
      if (typeof next === "string" && !next.startsWith("-")) index += 1;
      warnDroppedCodexOnlyArg(arg);
      continue;
    }
    if (
      arg === "--skip-git-repo-check"
      || arg === "--ephemeral"
      || arg === "--ignore-user-config"
      || arg === "--ignore-rules"
    ) {
      warnDroppedCodexOnlyArg(arg);
      continue;
    }
    translated.push(arg);
  }

  return hasPrint ? translated : [CODEBUDDY_PRINT_FLAG, ...translated];
}

export function translateClaudeResumeArgs(args: string[]): string[] {
  if (args[0] !== "resume") return [...args];
  const rest = args.slice(1);
  const translated: string[] = [];
  let useContinue = false;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--last") {
      useContinue = true;
      continue;
    }
    if (arg === "--all" || arg === "--include-non-interactive") {
      warnDroppedCodexOnlyArg(`resume ${arg}`);
      continue;
    }
    translated.push(arg);
  }

  return [useContinue ? "--continue" : "--resume", ...translated];
}

export function translateLeaderResumeArgs(args: string[], leaderCli: LeaderCli): string[] {
  switch (leaderCli) {
    case "codebuddy":
      return translateCodeBuddyResumeArgs(args);
    case "claude":
      return translateClaudeResumeArgs(args);
    case "codex":
      // codex CLI accepts `resume` as a real subcommand — pass through unchanged.
      return [...args];
  }
}

export function translateClaudeExecArgs(args: string[]): string[] {
  // claude doesn't accept an `exec` subcommand — it uses -p/--print for
  // non-interactive runs. Inject --print only if the caller didn't already
  // supply it (or its short alias -p) so we don't duplicate the flag.
  const hasPrint = args.includes("--print") || args.includes("-p");
  return hasPrint ? [...args] : ["--print", ...args];
}

export function translateLeaderExecArgs(args: string[], leaderCli: LeaderCli): string[] {
  switch (leaderCli) {
    case "codebuddy":
      return translateCodeBuddyExecArgs(args);
    case "claude":
      return translateClaudeExecArgs(args);
    case "codex":
      // codex CLI accepts `exec` as a real subcommand — pass through.
      return ["exec", ...args];
  }
}

export function injectLeaderModelInstructionsBypassArgs(
  cwd: string,
  args: string[],
  leaderCli: LeaderCli,
  env: NodeJS.ProcessEnv = process.env,
  defaultFilePath?: string,
): string[] {
  if (args.includes("--help") || args.includes("-h")) return [...args];
  if (!shouldBypassDefaultSystemPrompt(env)) return [...args];
  if (hasModelInstructionsOverride(args)) return [...args];
  // claude reads AGENTS.md / CLAUDE.md natively from the cwd, and its -c
  // flag is `--continue` (NOT codex-style `--config key=value`). Reusing the
  // codex injection here makes claude treat -c as continue and exit 1 with
  // "No deferred tool marker found in the resumed session". Skip injection.
  if (leaderCli === "claude") return [...args];
  const modelInstructionsPath = resolveModelInstructionsFilePath(cwd, env, defaultFilePath);
  switch (leaderCli) {
    case "codebuddy":
      return [...args, CODEBUDDY_SYSTEM_PROMPT_FILE_FLAG, modelInstructionsPath];
    case "codex":
      return [...args, CONFIG_FLAG, `${MODEL_INSTRUCTIONS_FILE_KEY}="${escapeTomlString(modelInstructionsPath)}"`];
    default: {
      // Adding a new LeaderCli without handling it here is a TS compile-time
      // error. The runtime guard mirrors the type narrowing for safety.
      const _exhaustive: never = leaderCli;
      throw new Error(`unhandled leader CLI: ${String(_exhaustive)}`);
    }
  }
}

export function injectModelInstructionsBypassArgs(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  defaultFilePath?: string,
): string[] {
  return injectLeaderModelInstructionsBypassArgs(cwd, args, "codebuddy", env, defaultFilePath);
}

export function resolveWorkerSparkModel(args: string[], codexHomeOverride?: string): string | undefined {
  for (const arg of args) {
    if (arg === SPARK_FLAG || arg === MADMAX_SPARK_FLAG) return resolveTeamLowComplexityDefaultModel(codexHomeOverride);
  }
  return undefined;
}

// ── Notify helpers ─────────────────────────────────────────────────────────

export function resolveNotifyTempContract(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): ParseNotifyTempContractResult {
  return parseNotifyTempContractFromArgs(args, env);
}

export function buildNotifyTempStartupMessages(
  contract: NotifyTempContract,
  hasValidProviders: boolean,
): { infoLines: string[]; warningLines: string[] } {
  const providers = contract.canonicalSelectors.length > 0 ? contract.canonicalSelectors.join(",") : "none";
  const infoLines = [`notify temp: active | providers=${providers} | persistent-routing=bypassed`];
  const warningLines = [...contract.warnings];
  if (!hasValidProviders) warningLines.push("notify temp: no valid providers resolved; notifications skipped");
  return { infoLines, warningLines };
}

export function buildNotifyFallbackWatcherEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { codexHomeOverride?: string; enableAuthority?: boolean; sessionId?: string; leaderCli?: LeaderCli } = {},
): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  delete nextEnv.TMUX;
  delete nextEnv.TMUX_PANE;
  const withProvider = buildProviderLeaderEnv(nextEnv, options.leaderCli ?? "codebuddy", options.codexHomeOverride);
  return {
    ...withProvider,
    ...(options.sessionId ? { OMB_SESSION_ID: options.sessionId } : {}),
    OMB_HUD_AUTHORITY: options.enableAuthority ? "1" : "0",
  };
}

/**
 * Mirror the resolved leader CLI into the current process' env so same-process
 * consumers (agents-overlay, worker-bootstrap, any function that reads ambient
 * OMB_LEADER_CLI) see the CLI actually driving this session. `--leader-cli` may
 * arrive via argv rather than env, so the leader process must publish it.
 *
 * Provider home env (CODEBUDDY_HOME / CODEX_HOME) is intentionally left
 * untouched: `resolveCodexHomeForLaunch` already resolved the intended home and
 * child-process envs use `buildProviderLeaderEnv` to scrub opposite-provider
 * home. We only touch OMB_LEADER_CLI here to keep the blast radius minimal.
 */
export function mirrorLeaderCliIntoProcessEnv(
  leaderCli: LeaderCli,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env[LEADER_CLI_ENV] = leaderCli;
}

export function providerHomeEnv(
  homeOverride: string | undefined,
  leaderCli: LeaderCli,
): NodeJS.ProcessEnv {
  // Always emit OMB_LEADER_CLI so downstream consumers (agents-overlay, worker-bootstrap,
  // nested team/autoresearch flows) can detect the active provider without guessing.
  const env: NodeJS.ProcessEnv = { [LEADER_CLI_ENV]: leaderCli };
  if (!homeOverride) return env;
  switch (leaderCli) {
    case "codebuddy":
      env.CODEBUDDY_HOME = homeOverride;
      env.CODEX_HOME = "";
      env.CLAUDE_HOME = "";
      return env;
    case "codex":
      env.CODEX_HOME = homeOverride;
      env.CODEBUDDY_HOME = "";
      env.CLAUDE_HOME = "";
      return env;
    case "claude":
      env.CLAUDE_HOME = homeOverride;
      env.CODEBUDDY_HOME = "";
      env.CODEX_HOME = "";
      return env;
  }
}

/**
 * Build a child-process env that unambiguously identifies the active leader CLI and its home.
 * Use this anywhere we spawn child processes (launch, exec, detached bootstrap, watchers,
 * autoresearch, team workers). Always call with the resolved `leaderCli` for the caller.
 */
export function buildProviderLeaderEnv(
  baseEnv: NodeJS.ProcessEnv,
  leaderCli: LeaderCli,
  homeOverride?: string,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  next[LEADER_CLI_ENV] = leaderCli;
  if (homeOverride) {
    switch (leaderCli) {
      case "codebuddy":
        next.CODEBUDDY_HOME = homeOverride;
        delete next.CODEX_HOME;
        delete next.CLAUDE_HOME;
        break;
      case "codex":
        next.CODEX_HOME = homeOverride;
        delete next.CODEBUDDY_HOME;
        delete next.CLAUDE_HOME;
        break;
      case "claude":
        next.CLAUDE_HOME = homeOverride;
        delete next.CODEBUDDY_HOME;
        delete next.CODEX_HOME;
        break;
    }
  } else {
    // Still clear the opposite provider's home so a leaked ambient env doesn't confuse
    // downstream consumers about which provider is active.
    switch (leaderCli) {
      case "codebuddy":
        delete next.CODEX_HOME;
        delete next.CLAUDE_HOME;
        break;
      case "codex":
        delete next.CODEBUDDY_HOME;
        delete next.CLAUDE_HOME;
        break;
      case "claude":
        delete next.CODEBUDDY_HOME;
        delete next.CODEX_HOME;
        break;
    }
  }
  return next;
}

export function shouldEnableNotifyFallbackWatcher(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const toggle = String(env.OMB_NOTIFY_FALLBACK ?? env.OMB_NOTIFY_FALLBACK ?? "").trim();
  if (platform === "win32") return toggle === "1";
  return toggle !== "0";
}

// ── Tmux session name ──────────────────────────────────────────────────────

function sanitizeTmuxToken(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

function tryReadGitValue(cwd: string, gitArgs: string[]): string | undefined {
  try {
    const value = execFileSync("git", gitArgs, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
    return value || undefined;
  } catch { return undefined; }
}

export function buildTmuxSessionName(cwd: string, sessionId: string): string {
  const parentPath = dirname(cwd);
  const parentDir = basename(parentPath);
  const dirName = basename(cwd);
  const grandparentPath = dirname(parentPath);
  const grandparentDir = basename(grandparentPath);
  const repoDir = parentDir.endsWith(".omb-worktrees")
    ? parentDir.slice(0, -".omb-worktrees".length)
    : parentDir.endsWith(".omb-worktrees")
      ? parentDir.slice(0, -".omb-worktrees".length)
      : parentDir === "worktrees" && (grandparentDir === ".omb" || grandparentDir === ".omb")
        ? basename(dirname(grandparentPath))
        : null;
  const dirToken = repoDir ? sanitizeTmuxToken(`${repoDir}-${dirName}`) : sanitizeTmuxToken(dirName);
  let branchToken = "detached";
  const branch = tryReadGitValue(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch) branchToken = sanitizeTmuxToken(branch);
  const sessionToken = sanitizeTmuxToken(sessionId.replace(/^omb-/, ""));
  const prefix = `omb-${dirToken}-${branchToken}`;
  const name = `${prefix}-${sessionToken}`;
  if (name.length <= 120) return name;
  const prefixBudget = Math.max(4, 120 - sessionToken.length - 1);
  const trimmedPrefix = prefix.slice(0, prefixBudget).replace(/-+$/g, "");
  return `${trimmedPrefix}-${sessionToken}`.slice(0, 120);
}

export function buildDetachedTmuxSessionName(cwd: string, sessionId: string): string {
  return buildTmuxSessionName(cwd, sessionId).replace(/^omb-/, "omb-");
}

// ── Tmux pane commands ─────────────────────────────────────────────────────

export function buildTmuxShellCommand(command: string, args: string[]): string {
  return [quoteShellArg(command), ...args.map(quoteShellArg)].join(" ");
}

function encodePowerShellCommand(commandText: string): string {
  return Buffer.from(commandText, "utf16le").toString("base64");
}

function isCodexVersionRequest(args: string[]): boolean {
  return args.some((arg) => VERSION_FLAGS.has(arg));
}

export function buildWindowsPromptCommand(command: string, args: string[]): string {
  const invocation = ["&", quotePowerShellArg(command), ...args.map(quotePowerShellArg)].join(" ");
  const wrappedCommand = ["$ErrorActionPreference = 'Stop'", `& { ${invocation} }`].join("; ");
  return `powershell.exe -NoLogo -NoExit -EncodedCommand ${encodePowerShellCommand(wrappedCommand)}`;
}

export function buildTmuxPaneCommand(
  command: string,
  args: string[],
  shellPath: string | undefined = process.env.SHELL,
): string {
  const bareCmd = buildTmuxShellCommand(command, args);
  let rcSource = "";
  if (shellPath && /\/zsh$/i.test(shellPath)) rcSource = "if [ -f ~/.zshrc ]; then source ~/.zshrc; fi; ";
  else if (shellPath && /\/bash$/i.test(shellPath)) rcSource = "if [ -f ~/.bashrc ]; then source ~/.bashrc; fi; ";
  const rawShell = shellPath && shellPath.trim() !== "" ? shellPath.trim() : "/bin/sh";
  const shellBin = ALLOWED_SHELLS.has(rawShell) ? rawShell : "/bin/sh";
  const inner = `${rcSource}exec ${bareCmd}`;
  return `${quoteShellArg(shellBin)} -c ${quoteShellArg(inner)}`;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ── Tmux extended keys lease ───────────────────────────────────────────────

interface TmuxExtendedKeysLeaseState {
  originalMode: string;
  holders: string[];
}

type TmuxExecSync = (file: string, args: readonly string[]) => string;

function execTmuxSync(
  args: readonly string[],
  execFileSyncImpl: TmuxExecSync = (file, tmuxArgs) => execFileSync(file, tmuxArgs, { encoding: "utf-8" }) as string,
): string {
  return execFileSyncImpl("tmux", [...args]).trim();
}

function sanitizeTmuxLeaseKey(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

function blockMs(ms: number): void {
  const delay = Math.max(1, Math.floor(ms));
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, delay);
}

function tmuxExtendedKeysLeaseRoot(cwd: string): string {
  return join(cwd, ".omb", "state", TMUX_EXTENDED_KEYS_LEASE_DIR);
}

function resolveTmuxSocketPath(
  execFileSyncImpl: TmuxExecSync = (file, tmuxArgs) => execFileSync(file, tmuxArgs, { encoding: "utf-8" }) as string,
): string {
  return execTmuxSync(["display-message", "-p", "#{socket_path}"], execFileSyncImpl) || "default";
}

function tmuxExtendedKeysLeasePath(cwd: string, socketPath: string): string {
  return join(tmuxExtendedKeysLeaseRoot(cwd), `${sanitizeTmuxLeaseKey(socketPath)}.json`);
}

function readTmuxExtendedKeysLeaseState(leasePath: string): TmuxExtendedKeysLeaseState | null {
  if (!existsSync(leasePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(leasePath, "utf-8")) as { originalMode?: unknown; holders?: unknown };
    if (typeof parsed.originalMode !== "string" || !Array.isArray(parsed.holders) || !parsed.holders.every((h) => typeof h === "string")) return null;
    return { originalMode: parsed.originalMode, holders: [...parsed.holders] };
  } catch { return null; }
}

function writeTmuxExtendedKeysLeaseState(leasePath: string, state: TmuxExtendedKeysLeaseState): void {
  mkdirSync(dirname(leasePath), { recursive: true });
  writeFileSync(leasePath, JSON.stringify(state, null, 2));
}

function withTmuxExtendedKeysLeaseLock<T>(cwd: string, socketPath: string, run: () => T): T {
  const leaseRoot = tmuxExtendedKeysLeaseRoot(cwd);
  mkdirSync(leaseRoot, { recursive: true });
  const lockPath = join(leaseRoot, `${sanitizeTmuxLeaseKey(socketPath)}.lock`);
  for (let attempt = 0; attempt < TMUX_EXTENDED_KEYS_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      mkdirSync(lockPath);
      try { return run(); } finally { rmSync(lockPath, { recursive: true, force: true }); }
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as NodeJS.ErrnoException).code) : "";
      if (code !== "EEXIST") throw err;
      blockMs(TMUX_EXTENDED_KEYS_LOCK_RETRY_MS);
    }
  }
  throw new Error(`timed out waiting for tmux extended-keys lease lock: ${lockPath}`);
}

export function acquireTmuxExtendedKeysLease(
  cwd: string,
  execFileSyncImpl: TmuxExecSync = (file, tmuxArgs) => execFileSync(file, tmuxArgs, { encoding: "utf-8" }) as string,
): string | null {
  try {
    const socketPath = resolveTmuxSocketPath(execFileSyncImpl);
    const leasePath = tmuxExtendedKeysLeasePath(cwd, socketPath);
    const leaseId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    withTmuxExtendedKeysLeaseLock(cwd, socketPath, () => {
      const state = readTmuxExtendedKeysLeaseState(leasePath);
      if (!state || state.holders.length === 0) {
        const previousMode = execTmuxSync(["show-options", "-sv", "extended-keys"], execFileSyncImpl) || TMUX_EXTENDED_KEYS_FALLBACK_MODE;
        execTmuxSync(["set-option", "-sq", "extended-keys", TMUX_EXTENDED_KEYS_MODE], execFileSyncImpl);
        writeTmuxExtendedKeysLeaseState(leasePath, { originalMode: previousMode, holders: [leaseId] });
        return;
      }
      state.holders.push(leaseId);
      writeTmuxExtendedKeysLeaseState(leasePath, state);
    });
    return `${socketPath}\t${leaseId}`;
  } catch (err) {
    process.stderr.write(`[cli/index] operation failed: ${err}\n`);
    return null;
  }
}

export function releaseTmuxExtendedKeysLease(
  cwd: string,
  leaseHandle: string,
  execFileSyncImpl: TmuxExecSync = (file, tmuxArgs) => execFileSync(file, tmuxArgs, { encoding: "utf-8" }) as string,
): void {
  if (!leaseHandle.trim()) return;
  const [socketPathRaw = "", leaseId = ""] = leaseHandle.split("\t");
  const socketPath = socketPathRaw.trim() || "default";
  if (!leaseId) return;
  try {
    const leasePath = tmuxExtendedKeysLeasePath(cwd, socketPath);
    withTmuxExtendedKeysLeaseLock(cwd, socketPath, () => {
      const state = readTmuxExtendedKeysLeaseState(leasePath);
      if (!state || state.holders.length === 0) { rmSync(leasePath, { force: true }); return; }
      const holders = state.holders.filter((h) => h !== leaseId);
      if (holders.length > 0) { writeTmuxExtendedKeysLeaseState(leasePath, { originalMode: state.originalMode, holders }); return; }
      execTmuxSync(["set-option", "-sq", "extended-keys", state.originalMode], execFileSyncImpl);
      rmSync(leasePath, { force: true });
    });
  } catch (err) {
    process.stderr.write(`[cli/index] operation failed: ${err}\n`);
  }
}

function buildTmuxExtendedKeysHelperCommand(cwd: string, operation: "acquire" | "release"): string {
  const cwdLiteral = JSON.stringify(cwd);
  const moduleUrlLiteral = JSON.stringify(import.meta.url);
  const script = operation === "acquire"
    ? `const mod = await import(${moduleUrlLiteral}); const lease = mod.acquireTmuxExtendedKeysLease(${cwdLiteral}); if (lease) process.stdout.write(lease);`
    : `const mod = await import(${moduleUrlLiteral}); mod.releaseTmuxExtendedKeysLease(${cwdLiteral}, process.argv[1] ?? "");`;
  return `${quoteShellArg(process.execPath)} --input-type=module -e ${quoteShellArg(script)}`;
}

function buildTmuxExtendedKeysAcquireShellSnippet(cwd: string): string {
  return `OMB_TMUX_EXTENDED_KEYS_LEASE=$(${buildTmuxExtendedKeysHelperCommand(cwd, "acquire")} 2>/dev/null || true);`;
}

function buildTmuxExtendedKeysReleaseShellSnippet(cwd: string): string {
  return `if [ -n "\${OMB_TMUX_EXTENDED_KEYS_LEASE:-}" ]; then ${buildTmuxExtendedKeysHelperCommand(cwd, "release")} "\${OMB_TMUX_EXTENDED_KEYS_LEASE}" >/dev/null 2>&1 || true; fi;`;
}

export function withTmuxExtendedKeys<T>(
  cwd: string,
  run: () => T,
  execFileSyncImpl: TmuxExecSync = (file, tmuxArgs) => execFileSync(file, tmuxArgs, { encoding: "utf-8" }) as string,
): T {
  const leaseHandle = acquireTmuxExtendedKeysLease(cwd, execFileSyncImpl);
  try { return run(); } finally { if (leaseHandle) releaseTmuxExtendedKeysLease(cwd, leaseHandle, execFileSyncImpl); }
}

function escapeShellDoubleQuotedValue(value: string): string {
  return value.replace(/["\\$`]/g, "\\$&");
}

function buildDetachedSessionLeaderCommand(cwd: string, sessionName: string, codexCmd: string): string {
  const wrapped = [
    buildTmuxExtendedKeysAcquireShellSnippet(cwd),
    "omb_detached_session_cleanup() {",
    "status=$?;",
    "trap - 0 INT TERM HUP;",
    buildTmuxExtendedKeysReleaseShellSnippet(cwd),
    'if [ "$status" -lt 128 ]; then',
    `case "\${${KILL_DETACHED_SESSION_ON_EXIT_ENV}:-0}" in`,
    "1|true|TRUE|yes|YES|on|ON)",
    `tmux kill-session -t "${escapeShellDoubleQuotedValue(sessionName)}" >/dev/null 2>&1 || true;`,
    ";;",
    "esac;",
    "fi;",
    "exit $status;",
    "};",
    "trap omb_detached_session_cleanup 0;",
    codexCmd,
  ].join(" ");
  return `/bin/sh -c ${quoteShellArg(wrapped)}`;
}

// ── Detached session steps ─────────────────────────────────────────────────

export interface DetachedSessionTmuxStep {
  name: string;
  args: string[];
}

function summarizeTmuxStepStream(stream: unknown): string | null {
  if (typeof stream === "string") {
    const trimmed = stream.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Buffer.isBuffer(stream)) {
    const trimmed = stream.toString("utf-8").trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

export function formatDetachedTmuxStepFailure(step: DetachedSessionTmuxStep, error: unknown): string {
  const command = `tmux ${step.args.map((arg) => JSON.stringify(arg)).join(" ")}`;
  if (!(error instanceof Error)) return `tmux step failed (${step.name}): ${command}: ${String(error)}`;
  const execError = error as Error & { status?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown };
  const details = [execError.message];
  if (typeof execError.status === "number") details.push(`status=${execError.status}`);
  if (typeof execError.signal === "string" && execError.signal.length > 0) details.push(`signal=${execError.signal}`);
  const stderr = summarizeTmuxStepStream(execError.stderr);
  if (stderr) details.push(`stderr=${stderr}`);
  const stdout = summarizeTmuxStepStream(execError.stdout);
  if (stdout) details.push(`stdout=${stdout}`);
  return `tmux step failed (${step.name}): ${command}: ${details.join(" | ")}`;
}

/**
 * Detects the tmux "no controlling terminal" failure class. Triggered when
 * `tmux attach-session` runs from a process whose stdio looked like a TTY at
 * probe time but cannot acquire a controlling terminal at attach time
 * (IDE-integrated terminals, GUI launchers, screen-inside-screen, redirected
 * stdio). tmux's canonical message is "open terminal failed: not a terminal";
 * the substring sniff covers minor wording variants without overreaching.
 */
export function isNoControllingTtyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const execError = error as Error & { stdout?: unknown; stderr?: unknown };
  const haystacks: string[] = [];
  if (typeof execError.message === "string") haystacks.push(execError.message);
  const stderr = summarizeTmuxStepStream(execError.stderr);
  if (stderr) haystacks.push(stderr);
  const stdout = summarizeTmuxStepStream(execError.stdout);
  if (stdout) haystacks.push(stdout);
  return haystacks.some((s) => s.toLowerCase().includes("not a terminal"));
}

/**
 * Build the user-facing instructional message printed when tmux attach-session
 * fails because the parent process has no controlling terminal. Uses bare
 * `tmux` (no absolute path) so the user's shell picks the highest-priority
 * tmux on PATH.
 */
export function buildManualAttachInstructionLines(sessionName: string): string[] {
  return [
    `[omb] tmux attach-session failed: this process has no controlling terminal, but the detached session was preserved.`,
    `[omb] To attach from a real terminal, run:`,
    `[omb]   tmux attach -t ${sessionName}`,
    `[omb] The leader process is already running inside the session; unsaved progress is preserved.`,
  ];
}

export function buildHudPaneCleanupTargets(
  existingPaneIds: string[],
  createdPaneId: string | null,
  leaderPaneId?: string,
): string[] {
  const targets = new Set<string>(existingPaneIds.filter((id) => id.startsWith("%")));
  if (createdPaneId && createdPaneId.startsWith("%")) targets.add(createdPaneId);
  if (leaderPaneId && leaderPaneId.startsWith("%")) targets.delete(leaderPaneId);
  return [...targets];
}

export function buildDetachedSessionBootstrapSteps(
  sessionName: string,
  cwd: string,
  codexCmd: string,
  hudCmd: string,
  workerLaunchArgs: string | null,
  codexHomeOverride?: string,
  notifyTempContractRaw?: string | null,
  nativeWindows = false,
  sessionId?: string,
  leaderCli: LeaderCli = "codebuddy",
): DetachedSessionTmuxStep[] {
  const detachedLeaderCmd = nativeWindows
    ? "powershell.exe"
    : buildDetachedSessionLeaderCommand(cwd, sessionName, codexCmd);
  const providerHomeAssignments = Object.entries(
    providerHomeEnv(codexHomeOverride, leaderCli),
  )
    .filter(([, value]) => value !== "")
    .flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const newSessionArgs: string[] = [
    "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", sessionName, "-c", cwd,
    ...(workerLaunchArgs ? ["-e", `${TEAM_WORKER_LAUNCH_ARGS_ENV}=${workerLaunchArgs}`] : []),
    ...(sessionId ? ["-e", `OMB_SESSION_ID=${sessionId}`, "-e", `OMB_SESSION_ID=${sessionId}`] : []),
    ...providerHomeAssignments,
    ...(notifyTempContractRaw ? ["-e", `${OMB_NOTIFY_TEMP_CONTRACT_ENV}=${notifyTempContractRaw}`] : []),
    detachedLeaderCmd,
  ];
  const splitCaptureArgs: string[] = [
    "split-window", "-v", "-l", String(HUD_TMUX_HEIGHT_LINES), "-d", "-t", sessionName, "-c", cwd, "-P", "-F", "#{pane_id}", hudCmd,
  ];
  return [
    { name: "new-session", args: newSessionArgs },
    { name: "split-and-capture-hud-pane", args: splitCaptureArgs },
  ];
}

export function buildDetachedSessionFinalizeSteps(
  sessionName: string,
  hudPaneId: string | null,
  hookWindowIndex: string | null,
  enableMouse: boolean,
  nativeWindows = false,
): DetachedSessionTmuxStep[] {
  const steps: DetachedSessionTmuxStep[] = [];
  if (!nativeWindows && hudPaneId && hookWindowIndex) {
    const hookTarget = buildResizeHookTarget(sessionName, hookWindowIndex);
    const hookName = buildResizeHookName("launch", sessionName, hookWindowIndex, hudPaneId);
    const clientAttachedHookName = buildClientAttachedReconcileHookName("launch", sessionName, hookWindowIndex, hudPaneId);
    steps.push({ name: "register-resize-hook", args: buildRegisterResizeHookArgs(hookTarget, hookName, hudPaneId, HUD_TMUX_HEIGHT_LINES) });
    steps.push({ name: "register-client-attached-reconcile", args: buildRegisterClientAttachedReconcileArgs(hookTarget, clientAttachedHookName, hudPaneId, HUD_TMUX_HEIGHT_LINES) });
    steps.push({ name: "schedule-delayed-resize", args: buildScheduleDelayedHudResizeArgs(hudPaneId, undefined, HUD_TMUX_HEIGHT_LINES) });
    steps.push({ name: "reconcile-hud-resize", args: buildReconcileHudResizeArgs(hudPaneId, HUD_TMUX_HEIGHT_LINES) });
  }
  if (enableMouse) steps.push({ name: "set-mouse", args: ["set-option", "-t", sessionName, "mouse", "on"] });
  steps.push({ name: "attach-session", args: ["attach-session", "-t", sessionName] });
  return steps;
}

export function buildDetachedSessionRollbackSteps(
  sessionName: string,
  hookTarget: string | null,
  hookName: string | null,
  clientAttachedHookName: string | null,
): DetachedSessionTmuxStep[] {
  const steps: DetachedSessionTmuxStep[] = [];
  if (hookTarget && clientAttachedHookName) steps.push({ name: "unregister-client-attached-reconcile", args: buildUnregisterClientAttachedReconcileArgs(hookTarget, clientAttachedHookName) });
  if (hookTarget && hookName) steps.push({ name: "unregister-resize-hook", args: buildUnregisterResizeHookArgs(hookTarget, hookName) });
  steps.push({ name: "kill-session", args: ["kill-session", "-t", sessionName] });
  return steps;
}

// ── Background helpers ─────────────────────────────────────────────────────

export function shouldDetachBackgroundHelper(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean { void env; void platform; return true; }

export type BackgroundHelperLaunchMode = "direct-detached" | "windows-msys-bootstrap";

export function resolveBackgroundHelperLaunchMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BackgroundHelperLaunchMode {
  return platform === "win32" && isMsysOrGitBash(env, platform) ? "windows-msys-bootstrap" : "direct-detached";
}

export function buildWindowsMsysBackgroundHelperBootstrapScript(
  helperArgs: readonly string[],
  cwd: string,
): string {
  const helperArgsLiteral = JSON.stringify(helperArgs);
  const cwdLiteral = JSON.stringify(cwd);
  return [
    "const { spawn } = require('child_process');",
    `const child = spawn(process.execPath, ${helperArgsLiteral}, { cwd: ${cwdLiteral}, detached: true, stdio: 'ignore', windowsHide: true, env: process.env });`,
    "if (!child.pid) process.exit(1);",
    "process.stdout.write(String(child.pid));",
    "child.unref();",
  ].join("");
}

async function launchBackgroundHelper(
  helperArgs: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number | undefined> {
  const launchMode = resolveBackgroundHelperLaunchMode(options.env, process.platform);
  if (launchMode === "windows-msys-bootstrap") {
    const { spawnSync } = await import("child_process");
    const bootstrap = spawnSync(process.execPath, ["-e", buildWindowsMsysBackgroundHelperBootstrapScript(helperArgs, options.cwd)], {
      cwd: options.cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: options.env,
    });
    if (bootstrap.error) throw bootstrap.error;
    if (bootstrap.status !== 0) {
      const detail = (bootstrap.stderr || bootstrap.stdout || "").trim();
      throw new Error(detail || `background helper bootstrap exited ${bootstrap.status}`);
    }
    const helperPid = Number.parseInt((bootstrap.stdout || "").trim(), 10);
    return Number.isFinite(helperPid) && helperPid > 0 ? helperPid : undefined;
  }
  const child = spawn(process.execPath, helperArgs, {
    cwd: options.cwd,
    detached: shouldDetachBackgroundHelper(options.env, process.platform),
    stdio: "ignore",
    windowsHide: true,
    env: options.env,
  });
  child.unref();
  return child.pid;
}

function parseWatcherPidFile(content: string): number | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isFinite(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    const pid = Number.parseInt(trimmed, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }
}

function tryKillPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
  try { process.kill(pid, signal); return true; } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    throw error;
  }
}

// ── Notify / watcher management ────────────────────────────────────────────

function notifyFallbackPidPath(cwd: string): string {
  return join(getBaseStateDir(cwd), "notify-fallback.pid");
}

function hookDerivedWatcherPidPath(cwd: string): string {
  return join(getBaseStateDir(cwd), "hook-derived-watcher.pid");
}

function resolveDistScript(pkgRoot: string, scriptName: string): string {
  return join(pkgRoot, "dist", "scripts", scriptName);
}

export function resolveNotifyFallbackWatcherScript(pkgRoot = getPackageRoot()): string {
  return resolveDistScript(pkgRoot, "notify-fallback-watcher.js");
}

export function resolveHookDerivedWatcherScript(pkgRoot = getPackageRoot()): string {
  return resolveDistScript(pkgRoot, "hook-derived-watcher.js");
}

export function resolveNotifyHookScript(pkgRoot = getPackageRoot()): string {
  return resolveDistScript(pkgRoot, "notify-hook.js");
}

export async function reapStaleNotifyFallbackWatcher(
  pidPath: string,
  deps: {
    exists?: (path: string) => boolean;
    readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
    tryKillPid?: (pid: number, signal?: NodeJS.Signals) => boolean;
    hasErrnoCode?: (error: unknown, code: string) => boolean;
    warn?: (message?: unknown, ...optionalParams: unknown[]) => void;
  } = {},
): Promise<void> {
  const exists = deps.exists ?? existsSync;
  if (!exists(pidPath)) return;
  const { readFile } = await import("fs/promises");
  const readFileImpl = deps.readFile ?? readFile;
  const tryKillPidImpl = deps.tryKillPid ?? tryKillPid;
  const hasErrnoCodeImpl = deps.hasErrnoCode ?? hasErrnoCode;
  const warn = deps.warn ?? console.warn;
  try {
    const prevPid = parseWatcherPidFile(await readFileImpl(pidPath, "utf-8"));
    if (prevPid) tryKillPidImpl(prevPid, "SIGTERM");
  } catch (error: unknown) {
    if (!hasErrnoCodeImpl(error, "ESRCH")) {
      warn("[omb] warning: failed to stop stale notify fallback watcher", { path: pidPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function startNotifyFallbackWatcher(
  cwd: string,
  options: { codexHomeOverride?: string; enableAuthority?: boolean; sessionId?: string; leaderCli?: LeaderCli } = {},
): Promise<void> {
  const { mkdir, writeFile } = await import("fs/promises");
  const pidPath = notifyFallbackPidPath(cwd);
  await reapStaleNotifyFallbackWatcher(pidPath);
  if (!shouldEnableNotifyFallbackWatcher(process.env, process.platform)) return;
  const pkgRoot = getPackageRoot();
  const watcherScript = resolveNotifyFallbackWatcherScript(pkgRoot);
  const notifyScript = resolveNotifyHookScript(pkgRoot);
  if (!existsSync(watcherScript) || !existsSync(notifyScript)) return;
  await mkdir(join(cwd, ".omb", "state"), { recursive: true }).catch((error: unknown) => {
    console.warn("[omb] warning: failed to create notify fallback watcher state directory", { cwd, error: error instanceof Error ? error.message : String(error) });
  });
  const watcherEnv = buildNotifyFallbackWatcherEnv(process.env, {
    codexHomeOverride: options.codexHomeOverride,
    enableAuthority: options.enableAuthority === true,
    sessionId: options.sessionId,
    leaderCli: options.leaderCli,
  });
  let watcherPid: number | undefined;
  try {
    watcherPid = await launchBackgroundHelper([
      watcherScript, "--cwd", cwd, "--notify-script", notifyScript, "--pid-file", pidPath, "--parent-pid", String(process.pid),
      ...(process.env.OMB_NOTIFY_FALLBACK_MAX_LIFETIME_MS ? ["--max-lifetime-ms", process.env.OMB_NOTIFY_FALLBACK_MAX_LIFETIME_MS] : []),
    ], { cwd, env: watcherEnv });
  } catch (error: unknown) {
    console.warn("[omb] warning: failed to launch notify fallback watcher", { cwd, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!watcherPid) return;
  await writeFile(pidPath, JSON.stringify({ pid: watcherPid, started_at: new Date().toISOString() }, null, 2))
    .catch((error: unknown) => { console.warn("[omb] warning: failed to write notify fallback watcher pid file", { path: pidPath, error: error instanceof Error ? error.message : String(error) }); });
}

async function startHookDerivedWatcher(cwd: string): Promise<void> {
  if (process.env.OMB_HOOK_DERIVED_SIGNALS !== "1") return;
  const { mkdir, writeFile, readFile } = await import("fs/promises");
  const pidPath = hookDerivedWatcherPidPath(cwd);
  const pkgRoot = getPackageRoot();
  const watcherScript = resolveHookDerivedWatcherScript(pkgRoot);
  if (!existsSync(watcherScript)) return;
  if (existsSync(pidPath)) {
    try {
      const prev = JSON.parse(await readFile(pidPath, "utf-8")) as { pid?: number };
      if (prev && typeof prev.pid === "number") process.kill(prev.pid, "SIGTERM");
    } catch (error: unknown) {
      console.warn("[omb] warning: failed to stop stale hook-derived watcher", { path: pidPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await mkdir(join(cwd, ".omb", "state"), { recursive: true }).catch((error: unknown) => {
    console.warn("[omb] warning: failed to create hook-derived watcher state directory", { cwd, error: error instanceof Error ? error.message : String(error) });
  });
  let watcherPid: number | undefined;
  try {
    watcherPid = await launchBackgroundHelper([watcherScript, "--cwd", cwd], { cwd, env: process.env });
  } catch (error: unknown) {
    console.warn("[omb] warning: failed to launch hook-derived watcher", { cwd, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!watcherPid) return;
  await writeFile(pidPath, JSON.stringify({ pid: watcherPid, started_at: new Date().toISOString() }, null, 2))
    .catch((error: unknown) => { console.warn("[omb] warning: failed to write hook-derived watcher pid file", { path: pidPath, error: error instanceof Error ? error.message : String(error) }); });
}

async function stopNotifyFallbackWatcher(cwd: string): Promise<void> {
  const { readFile, unlink } = await import("fs/promises");
  const pidPath = notifyFallbackPidPath(cwd);
  if (!existsSync(pidPath)) return;
  try {
    const pid = parseWatcherPidFile(await readFile(pidPath, "utf-8"));
    if (pid) tryKillPid(pid, "SIGTERM");
  } catch (error: unknown) {
    if (!hasErrnoCode(error, "ESRCH")) {
      console.warn("[omb] warning: failed to stop notify fallback watcher process", { path: pidPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await unlink(pidPath).catch((error: unknown) => { console.warn("[omb] warning: failed to remove notify fallback watcher pid file", { path: pidPath, error: error instanceof Error ? error.message : String(error) }); });
}

async function stopHookDerivedWatcher(cwd: string): Promise<void> {
  const { readFile, unlink } = await import("fs/promises");
  const pidPath = hookDerivedWatcherPidPath(cwd);
  if (!existsSync(pidPath)) return;
  try {
    const parsed = JSON.parse(await readFile(pidPath, "utf-8")) as { pid?: number };
    if (parsed && typeof parsed.pid === "number") process.kill(parsed.pid, "SIGTERM");
  } catch (error: unknown) {
    console.warn("[omb] warning: failed to stop hook-derived watcher process", { path: pidPath, error: error instanceof Error ? error.message : String(error) });
  }
  await unlink(pidPath).catch((error: unknown) => { console.warn("[omb] warning: failed to remove hook-derived watcher pid file", { path: pidPath, error: error instanceof Error ? error.message : String(error) }); });
}

async function flushNotifyFallbackOnce(
  cwd: string,
  options: { codexHomeOverride?: string; enableAuthority?: boolean; sessionId?: string; leaderCli?: LeaderCli } = {},
): Promise<void> {
  if (!shouldEnableNotifyFallbackWatcher(process.env, process.platform)) return;
  const { spawnSync } = await import("child_process");
  const pkgRoot = getPackageRoot();
  const watcherScript = resolveNotifyFallbackWatcherScript(pkgRoot);
  const notifyScript = resolveNotifyHookScript(pkgRoot);
  if (!existsSync(watcherScript) || !existsSync(notifyScript)) return;
  spawnSync(process.execPath, [watcherScript, "--once", "--cwd", cwd, "--notify-script", notifyScript], {
    cwd, stdio: "ignore", timeout: 3000, windowsHide: true,
    env: buildNotifyFallbackWatcherEnv(process.env, {
      codexHomeOverride: options.codexHomeOverride,
      enableAuthority: options.enableAuthority === true,
      sessionId: options.sessionId,
      leaderCli: options.leaderCli,
    }),
  });
}

async function flushHookDerivedWatcherOnce(cwd: string): Promise<void> {
  if (process.env.OMB_HOOK_DERIVED_SIGNALS !== "1") return;
  const { spawnSync } = await import("child_process");
  const pkgRoot = getPackageRoot();
  const watcherScript = resolveHookDerivedWatcherScript(pkgRoot);
  if (!existsSync(watcherScript)) return;
  spawnSync(process.execPath, [watcherScript, "--once", "--cwd", cwd], {
    cwd, stdio: "ignore", timeout: 3000, windowsHide: true,
    env: { ...process.env, OMB_HOOK_DERIVED_SIGNALS: "1" },
  });
}

// ── MCP orphan cleanup ─────────────────────────────────────────────────────

import {
  cleanupOmbMcpProcesses,
  findLaunchSafeCleanupCandidates,
  type CleanupDependencies,
  type CleanupResult,
} from "../cleanup.js";

export async function cleanupLaunchOrphanedMcpProcesses(
  dependencies: CleanupDependencies = {},
): Promise<CleanupResult> {
  return cleanupOmbMcpProcesses([], {
    ...dependencies,
    selectCandidates: dependencies.selectCandidates ?? findLaunchSafeCleanupCandidates,
    writeLine: dependencies.writeLine ?? (() => {}),
  });
}

// ── Post-launch mode state ─────────────────────────────────────────────────

interface PostLaunchCleanupDependencies {
  cleanup?: () => Promise<CleanupResult>;
  writeInfo?: (line: string) => void;
  writeWarn?: (line: string) => void;
  writeError?: (line: string) => void;
}

interface PostLaunchModeCleanupDependencies {
  readdir?: typeof import("fs/promises").readdir;
  readFile?: typeof import("fs/promises").readFile;
  writeFile?: typeof import("fs/promises").writeFile;
  sleep?: (ms: number) => Promise<void>;
  writeWarn?: (line: string) => void;
  now?: () => Date;
}

type PostLaunchModeStateReadResult =
  | { kind: "ok"; state: Record<string, unknown> }
  | { kind: "missing" | "recoverable" }
  | { kind: "malformed"; message: string };

const POST_LAUNCH_MODE_STATE_RETRY_DELAY_MS = 10;
const POST_LAUNCH_MODE_STATE_MAX_READ_ATTEMPTS = 2;

function isLikelyTransientModeStateParseFailure(raw: string, err: unknown): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return true;
  if (!(err instanceof SyntaxError)) return false;
  if (!trimmed.startsWith("{") || trimmed.endsWith("}")) return false;
  return (
    /Unexpected end of JSON input/.test(err.message) ||
    /Unterminated string in JSON/.test(err.message) ||
    /Expected double-quoted property name in JSON/.test(err.message) ||
    /Expected property name or '}' in JSON/.test(err.message) ||
    /Expected ':' after property name in JSON/.test(err.message) ||
    /Expected ',' or '}' after property value in JSON/.test(err.message)
  );
}

async function readPostLaunchModeStateFile(
  path: string,
  dependencies: Pick<PostLaunchModeCleanupDependencies, "readFile" | "sleep"> = {},
): Promise<PostLaunchModeStateReadResult> {
  const readFile = dependencies.readFile ?? (await import("fs/promises")).readFile;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= POST_LAUNCH_MODE_STATE_MAX_READ_ATTEMPTS; attempt++) {
    try {
      const raw = await readFile(path, "utf-8");
      const trimmed = raw.trim();
      if (trimmed.length === 0) { if (attempt < POST_LAUNCH_MODE_STATE_MAX_READ_ATTEMPTS) { await sleep(POST_LAUNCH_MODE_STATE_RETRY_DELAY_MS); continue; } return { kind: "recoverable" }; }
      let parsed: unknown;
      try { parsed = JSON.parse(raw) as unknown; } catch (err) {
        if (isLikelyTransientModeStateParseFailure(raw, err)) { if (attempt < POST_LAUNCH_MODE_STATE_MAX_READ_ATTEMPTS) { await sleep(POST_LAUNCH_MODE_STATE_RETRY_DELAY_MS); continue; } return { kind: "recoverable" }; }
        return { kind: "malformed", message: err instanceof Error ? err.message : String(err) };
      }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return { kind: "malformed", message: "mode state must be a JSON object" };
      return { kind: "ok", state: parsed as Record<string, unknown> };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error?.code === "ENOENT") return { kind: "missing" };
      return { kind: "malformed", message: err instanceof Error ? err.message : String(err) };
    }
  }
  return { kind: "recoverable" };
}

function buildRecoveredPostLaunchModeState(mode: string, completedAt: string): Record<string, unknown> {
  return { active: false, mode, current_phase: "cancelled", completed_at: completedAt, last_turn_at: completedAt };
}

export async function cleanupPostLaunchModeStateFiles(
  cwd: string,
  sessionId: string,
  dependencies: PostLaunchModeCleanupDependencies = {},
): Promise<void> {
  const readdir = dependencies.readdir ?? (await import("fs/promises")).readdir;
  const writeFile = dependencies.writeFile ?? (await import("fs/promises")).writeFile;
  const writeWarn = dependencies.writeWarn ?? console.warn;
  const now = dependencies.now ?? (() => new Date());
  const scopedDirs = [getBaseStateDir(cwd), getStateDir(cwd, sessionId)];
  for (const stateDir of scopedDirs) {
    const files = await readdir(stateDir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith("-state.json") || file === "session.json") continue;
      const path = join(stateDir, file);
      const mode = file.slice(0, -"-state.json".length);
      const result = await readPostLaunchModeStateFile(path, dependencies);
      if (result.kind !== "ok") {
        if (result.kind === "recoverable") {
          try { const completedAt = now().toISOString(); await writeFile(path, JSON.stringify(buildRecoveredPostLaunchModeState(mode, completedAt), null, 2)); } catch (err) { writeWarn(`[omb] postLaunch: failed to recover mode state ${path}: ${err instanceof Error ? err.message : err}`); }
        } else if (result.kind === "malformed") {
          writeWarn(`[omb] postLaunch: skipped malformed mode state ${path}: ${result.message}`);
        }
        continue;
      }
      if (result.state.active !== true) continue;
      try { result.state.active = false; result.state.completed_at = now().toISOString(); await writeFile(path, JSON.stringify(result.state, null, 2)); } catch (err) { writeWarn(`[omb] postLaunch: failed to update mode state ${path}: ${err instanceof Error ? err.message : err}`); }
    }
  }
}

export async function reapPostLaunchOrphanedMcpProcesses(
  dependencies: PostLaunchCleanupDependencies = {},
): Promise<void> {
  const cleanup = dependencies.cleanup ?? cleanupLaunchOrphanedMcpProcesses;
  const writeInfo = dependencies.writeInfo ?? console.log;
  const writeWarn = dependencies.writeWarn ?? console.warn;
  const writeError = dependencies.writeError ?? ((line: string) => process.stderr.write(line));
  try {
    const result = await cleanup();
    if (result.terminatedCount > 0) writeInfo(`[omb] postLaunch: reaped ${result.terminatedCount} orphaned OMB MCP process(es).`);
    if (result.failedPids.length > 0) writeWarn(`[omb] postLaunch: failed to reap ${result.failedPids.length} orphaned OMB MCP process(es); continuing cleanup.`);
  } catch (err) { writeError(`[cli/index] postLaunch MCP cleanup failed: ${err}\n`); }
}

// ── Hook events ────────────────────────────────────────────────────────────

function extractIssueNumber(text: string): number | undefined {
  const explicit = text.match(/\bissue\s*#(\d+)\b/i);
  if (explicit) return Number.parseInt(explicit[1], 10);
  const generic = text.match(/(^|[^\w/])#(\d+)\b/);
  return generic ? Number.parseInt(generic[2], 10) : undefined;
}

function resolveNativeSessionName(cwd: string, sessionId: string): string {
  if (process.env.TMUX) {
    try {
      const tmuxSession = execFileSync("tmux", ["display-message", "-p", "#S"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
      if (tmuxSession) return tmuxSession;
    } catch { /* best effort */ }
  }
  return buildTmuxSessionName(cwd, sessionId);
}

function buildNativeHookBaseContext(
  cwd: string,
  sessionId: string,
  normalizedEvent: "started" | "blocked" | "finished" | "failed",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const repoPath = tryReadGitValue(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
  const branch = tryReadGitValue(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const issueNumber = extractIssueNumber([branch, basename(cwd)].filter(Boolean).join(" "));
  return {
    normalized_event: normalizedEvent,
    session_name: resolveNativeSessionName(cwd, sessionId),
    repo_path: repoPath,
    repo_name: basename(repoPath),
    worktree_path: cwd,
    ...(branch ? { branch } : {}),
    ...(issueNumber !== undefined ? { issue_number: issueNumber } : {}),
    ...extra,
  };
}

async function emitNativeHookEvent(
  cwd: string,
  event: "session-start" | "session-end" | "session-idle" | "turn-complete",
  opts: { session_id?: string; thread_id?: string; turn_id?: string; mode?: string; context?: Record<string, unknown> } = {},
): Promise<void> {
  const payload = buildHookEvent(event, { source: "native", context: opts.context || {}, session_id: opts.session_id, thread_id: opts.thread_id, turn_id: opts.turn_id, mode: opts.mode });
  await dispatchHookEvent(payload, { cwd, enabled: true });
}

// ── Launch append instructions ─────────────────────────────────────────────

async function readLaunchAppendInstructions(): Promise<string> {
  const appendixCandidates = [
    process.env[OMB_RALPH_APPEND_INSTRUCTIONS_FILE_ENV]?.trim(),
    process.env[OMB_AUTORESEARCH_APPEND_INSTRUCTIONS_FILE_ENV]?.trim(),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  if (appendixCandidates.length === 0) return "";
  const appendixPath = appendixCandidates[0];
  if (!existsSync(appendixPath)) throw new Error(`launch instructions file not found: ${appendixPath}`);
  const { readFile } = await import("fs/promises");
  return (await readFile(appendixPath, "utf-8")).trim();
}

// ── Team worker args ───────────────────────────────────────────────────────

export function collectInheritableTeamWorkerArgs(codexArgs: string[]): string[] {
  return collectInheritableTeamWorkerArgsShared(codexArgs);
}

export function resolveTeamWorkerLaunchArgsEnv(
  existingRaw: string | undefined,
  codexArgs: string[],
  inheritLeaderFlags = true,
  defaultModel?: string,
): string | null {
  const inheritedArgs = inheritLeaderFlags ? collectInheritableTeamWorkerArgs(codexArgs) : [];
  const normalized = resolveTeamWorkerLaunchArgs({ existingRaw, inheritedArgs, fallbackModel: defaultModel });
  if (normalized.length === 0) return null;
  return normalized.join(" ");
}

// ── Windows detached ──────────────────────────────────────────────────────

function buildDetachedWindowsBootstrapScript(
  sessionName: string,
  commandText: string,
  delayMs: number = WINDOWS_DETACHED_BOOTSTRAP_DELAY_MS,
): string {
  const delay = Number.isFinite(delayMs) && delayMs > 0 ? Math.floor(delayMs) : WINDOWS_DETACHED_BOOTSTRAP_DELAY_MS;
  const targetLiteral = JSON.stringify(`${sessionName}:0.0`);
  const commandLiteral = JSON.stringify(commandText);
  return [
    "const { execFileSync } = require('child_process');",
    `setTimeout(() => {`,
    `try { execFileSync('tmux', ['send-keys', '-t', ${targetLiteral}, '-l', '--', ${commandLiteral}], { stdio: 'ignore' }); } catch {}`,
    `try { execFileSync('tmux', ['send-keys', '-t', ${targetLiteral}, 'C-m'], { stdio: 'ignore' }); } catch {}`,
    `}, ${delay});`,
  ].join("");
}

function scheduleDetachedWindowsCodexLaunch(sessionName: string, commandText: string): void {
  const child = spawn(process.execPath, ["-e", buildDetachedWindowsBootstrapScript(sessionName, commandText)], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function parseWindowIndexFromTmuxOutput(rawOutput: string): string | null {
  const windowIndex = rawOutput.split("\n")[0]?.trim() || "";
  return /^[0-9]+$/.test(windowIndex) ? windowIndex : null;
}

function detectDetachedSessionWindowIndex(sessionName: string): string | null {
  try {
    const output = execFileSync("tmux", ["display-message", "-p", "-t", sessionName, "#{window_index}"], { encoding: "utf-8" });
    return parseWindowIndexFromTmuxOutput(output);
  } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); return null; }
}

// ── HUD pane helpers ───────────────────────────────────────────────────────

function listHudWatchPaneIdsInCurrentWindow(currentPaneId?: string): string[] {
  try { return listCurrentWindowHudPaneIds(currentPaneId); } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); return []; }
}

function createHudWatchPane(cwd: string, hudCmd: string): string | null {
  return createSharedHudWatchPane(cwd, hudCmd, { heightLines: HUD_TMUX_HEIGHT_LINES });
}

function killTmuxPane(paneId: string): void {
  if (!paneId.startsWith("%")) return;
  try { killSharedTmuxPane(paneId); } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
}

// ── Codex home resolution ──────────────────────────────────────────────────

import {
  SETUP_PROVIDERS,
  SETUP_SCOPES,
  type SetupProvider,
  type SetupScope,
} from "../setup.js";

const LEGACY_SCOPE_MIGRATION_SYNC: Record<string, SetupScope> = { "project-local": "project" };

export function readPersistedSetupScope(cwd: string): SetupScope | undefined {
  return readPersistedSetupPreferences(cwd)?.scope;
}

export function readPersistedSetupPreferences(
  cwd: string,
): Partial<{ provider: SetupProvider; scope: SetupScope }> | undefined {
  for (const scopePath of [join(cwd, ".omb", "setup-scope.json"), join(cwd, ".omb", "setup-scope.json")]) {
    if (!existsSync(scopePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(scopePath, "utf-8")) as Partial<{ provider: string; scope: string }>;
      const persisted: Partial<{ provider: SetupProvider; scope: SetupScope }> = {};
      if (typeof parsed.scope === "string") {
        if (SETUP_SCOPES.includes(parsed.scope as SetupScope)) persisted.scope = parsed.scope as SetupScope;
        const migrated = LEGACY_SCOPE_MIGRATION_SYNC[parsed.scope];
        if (migrated) persisted.scope = migrated;
      }
      if (typeof parsed.provider === "string" && SETUP_PROVIDERS.includes(parsed.provider as SetupProvider)) persisted.provider = parsed.provider as SetupProvider;
      return Object.keys(persisted).length > 0 ? persisted : undefined;
    } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
  }
  return undefined;
}

export function resolveCodexHomeForLaunch(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  leaderCli: LeaderCli = "codebuddy",
): string | undefined {
  switch (leaderCli) {
    case "codebuddy":
      if (env.CODEBUDDY_HOME && env.CODEBUDDY_HOME.trim() !== "") return env.CODEBUDDY_HOME;
      break;
    case "codex":
      if (env.CODEX_HOME && env.CODEX_HOME.trim() !== "") return env.CODEX_HOME;
      break;
    case "claude":
      if (env.CLAUDE_HOME && env.CLAUDE_HOME.trim() !== "") return env.CLAUDE_HOME;
      break;
  }
  const persisted = readPersistedSetupPreferences(cwd);
  if (persisted?.scope === "project") {
    switch (leaderCli) {
      case "codebuddy":
        return join(cwd, ".codebuddy");
      case "codex":
        return join(cwd, ".codex");
      case "claude":
        return join(cwd, ".claude");
    }
  }
  return undefined;
}

export function resolveSetupProviderArg(args: string[]): SetupProvider | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--provider") { const next = args[index + 1]; if (!next || next.startsWith("-")) throw new Error(`Missing setup provider value after --provider. Expected one of: ${SETUP_PROVIDERS.join(", ")}`); value = next; index += 1; continue; }
    if (arg.startsWith("--provider=")) value = arg.slice("--provider=".length);
  }
  if (!value) return undefined;
  if (SETUP_PROVIDERS.includes(value as SetupProvider)) return value as SetupProvider;
  throw new Error(`Invalid setup provider: ${value}. Expected one of: ${SETUP_PROVIDERS.join(", ")}`);
}

export function resolveSetupScopeArg(args: string[]): SetupScope | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--scope") { const next = args[index + 1]; if (!next || next.startsWith("-")) throw new Error(`Missing setup scope value after --scope. Expected one of: ${SETUP_SCOPES.join(", ")}`); value = next; index += 1; continue; }
    if (arg.startsWith("--scope=")) value = arg.slice("--scope=".length);
  }
  if (!value) return undefined;
  if (SETUP_SCOPES.includes(value as SetupScope)) return value as SetupScope;
  throw new Error(`Invalid setup scope: ${value}. Expected one of: ${SETUP_SCOPES.join(", ")}`);
}

// ── TOML helpers ───────────────────────────────────────────────────────────

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function readTopLevelTomlString(content: string, key: string): string | null {
  let inTopLevel = true;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\[[^[\]]+\]\s*(#.*)?$/.test(trimmed)) { inTopLevel = false; continue; }
    if (!inTopLevel) continue;
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (!match || match[1] !== key) continue;
    return parseTomlStringValue(match[2]);
  }
  return null;
}

export function upsertTopLevelTomlString(content: string, key: string, value: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const assignment = `${key} = "${escapeTomlString(value)}"`;
  if (!content.trim()) return assignment + eol;
  const lines = content.split(/\r?\n/);
  let replaced = false;
  let inTopLevel = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\[[^[\]]+\]\s*(#.*)?$/.test(trimmed)) { inTopLevel = false; continue; }
    if (!inTopLevel) continue;
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
    if (match && match[1] === key) { lines[i] = assignment; replaced = true; break; }
  }
  if (!replaced) {
    const firstTableIndex = lines.findIndex((line) => /^\s*\[[^[\]]+\]\s*(#.*)?$/.test(line.trim()));
    if (firstTableIndex >= 0) lines.splice(firstTableIndex, 0, assignment);
    else lines.push(assignment);
  }
  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}

// ── Pipeline stages ────────────────────────────────────────────────────────

/**
 * Preflight: update prompt, star prompt, config repair.
 * All steps are non-fatal.
 */
async function preflight(cwd: string): Promise<void> {
  try { await maybeCheckAndPromptUpdate(cwd); } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
  try { await maybePromptGithubStar(); } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
  try {
    const repaired = await repairConfigIfNeeded(codexConfigPath(), getPackageRoot());
    if (repaired) console.log("[omb] Repaired managed config.toml compatibility issue.");
  } catch { /* Non-fatal */ }
}

/**
 * preLaunch: Prepare environment before Codex starts.
 * Best-effort launch-safe orphan cleanup, overlay generation, session start, watchers, hooks.
 */
async function preLaunch(
  cwd: string,
  sessionId: string,
  notifyTempContract?: NotifyTempContract,
  codexHomeOverride?: string,
  enableNotifyFallbackAuthority: boolean = false,
  leaderCli: LeaderCli = "codebuddy",
): Promise<void> {
  // Ensure same-process consumers (agents-overlay, worker-bootstrap, and any
  // function that reads ambient OMB_LEADER_CLI) see the CLI actually driving
  // this session. `--leader-cli` may have arrived via argv rather than env,
  // so mirror it into process.env up-front; we only set this key, leaving
  // provider home env alone since resolveCodexHomeForLaunch has already
  // resolved the intended home override.
  mirrorLeaderCliIntoProcessEnv(leaderCli);
  // 1. Best-effort launch-safe orphan cleanup
  try {
    const cleanup = await cleanupLaunchOrphanedMcpProcesses();
    if (cleanup.terminatedCount > 0) console.log(`[omb] Reaped ${cleanup.terminatedCount} orphaned OMB MCP process(es) before launch.`);
    if (cleanup.failedPids.length > 0) console.warn(`[omb] Failed to reap ${cleanup.failedPids.length} orphaned OMB MCP process(es); continuing launch.`);
  } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }

  // 2. Generate runtime overlay + write session-scoped model instructions file
  const orchestrationMode = await resolveSessionOrchestrationMode(cwd, sessionId);
  const overlay = await generateOverlay(cwd, sessionId, { orchestrationMode });
  const launchAppendix = await readLaunchAppendInstructions();
  const sessionInstructions = launchAppendix.trim().length > 0 ? `${overlay}\n\n${launchAppendix}` : overlay;
  await writeSessionModelInstructionsFile(cwd, sessionId, sessionInstructions);

  // 3. Write session state
  await resetSessionMetrics(cwd);
  await writeSessionStart(cwd, sessionId, { leaderCli });

  // 4. Start notify fallback watcher (best effort)
  try { await startNotifyFallbackWatcher(cwd, { codexHomeOverride, enableAuthority: enableNotifyFallbackAuthority, sessionId, leaderCli }); } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }

  // 5. Start derived watcher (best effort, opt-in)
  try { await startHookDerivedWatcher(cwd); } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }

  // 6. Emit temp notification startup summary + warnings, then send session-start lifecycle notification (best effort)
  try {
    if (notifyTempContract?.active) {
      process.env[OMB_NOTIFY_TEMP_CONTRACT_ENV] = serializeNotifyTempContract(notifyTempContract);
      const { getNotificationConfig } = await import("../../notifications/config.js");
      const resolved = getNotificationConfig();
      const startup = buildNotifyTempStartupMessages(notifyTempContract, Boolean(resolved?.enabled));
      for (const info of startup.infoLines) console.log(`[omb] ${info}`);
      for (const warning of startup.warningLines) console.warn(`[omb] ${warning}`);
    } else { delete process.env[OMB_NOTIFY_TEMP_CONTRACT_ENV]; }
    const { notifyLifecycle } = await import("../../notifications/index.js");
    await notifyLifecycle("session-start", { sessionId, projectPath: cwd, projectName: basename(cwd) });
  } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }

  // 7. Dispatch native hook event (best effort)
  try {
    await emitNativeHookEvent(cwd, "session-start", {
      session_id: sessionId,
      context: buildNativeHookBaseContext(cwd, sessionId, "started", { project_path: cwd, project_name: basename(cwd), status: "started" }),
    });
  } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
}

/**
 * runCodex: Launch CodeBuddy CLI (blocks until exit).
 * All 3 paths (new tmux, existing tmux, no tmux) block via execSync/execFileSync.
 */
function runCodex(
  cwd: string,
  args: string[],
  sessionId: string,
  leaderCli: LeaderCli,
  workerDefaultModel?: string,
  codexHomeOverride?: string,
  notifyTempContractRaw?: string | null,
  explicitLaunchPolicy?: CodexLaunchPolicy,
): void {
  const launchArgs = injectLeaderModelInstructionsBypassArgs(cwd, args, leaderCli, process.env, sessionModelInstructionsPath(cwd, sessionId));
  const nativeWindows = isNativeWindows();
  const ombBin = resolveOmbCliEntryPath();
  if (!ombBin) throw new Error("Unable to resolve OMB launcher path for tmux HUD bootstrap");
  const hudCmd = nativeWindows ? buildWindowsPromptCommand("node", [ombBin, "hud", "--watch"]) : buildTmuxPaneCommand("node", [ombBin, "hud", "--watch"]);
  const inheritLeaderFlags = process.env[TEAM_INHERIT_LEADER_FLAGS_ENV] !== "0";
  const workerLaunchArgs = resolveTeamWorkerLaunchArgsEnv(process.env[TEAM_WORKER_LAUNCH_ARGS_ENV], launchArgs, inheritLeaderFlags, workerDefaultModel);
  const codexBaseEnv = buildProviderLeaderEnv(process.env, leaderCli, codexHomeOverride);
  const codexEnvWithSession = { ...codexBaseEnv, OMB_SESSION_ID: sessionId };
  const codexEnv = workerLaunchArgs ? { ...codexEnvWithSession, [TEAM_WORKER_LAUNCH_ARGS_ENV]: workerLaunchArgs } : codexEnvWithSession;
  const codexEnvWithNotify = notifyTempContractRaw ? { ...codexEnv, [OMB_NOTIFY_TEMP_CONTRACT_ENV]: notifyTempContractRaw } : codexEnv;
  const translatedLaunchArgs = translateLeaderResumeArgs(launchArgs, leaderCli);
  const launchBinary = resolveLeaderCliBinary(leaderCli);
  const launchPolicy = resolveCodexLaunchPolicy(process.env, process.platform, undefined, nativeWindows, undefined, undefined, explicitLaunchPolicy);

  if (leaderCli === "codebuddy") ensureCodeBuddyAvailable(cwd, codexEnvWithNotify);

  if (isCodexVersionRequest(translatedLaunchArgs)) { runCodexBlocking(cwd, launchBinary, translatedLaunchArgs, codexEnvWithNotify); return; }

  if (launchPolicy === "inside-tmux") {
    const currentPaneId = process.env.TMUX_PANE;
    const staleHudPaneIds = listHudWatchPaneIdsInCurrentWindow(currentPaneId);
    for (const paneId of staleHudPaneIds) killTmuxPane(paneId);
    let hudPaneId: string | null = null;
    try { hudPaneId = createHudWatchPane(cwd, hudCmd); } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
    if (process.env.OMB_MOUSE !== "0") {
      try {
        const tmuxPaneTarget = process.env.TMUX_PANE;
        const displayArgs = tmuxPaneTarget ? ["display-message", "-p", "-t", tmuxPaneTarget, "#S"] : ["display-message", "-p", "#S"];
        const tmuxSession = execFileSync("tmux", displayArgs, { encoding: "utf-8" }).trim();
        if (tmuxSession) enableMouseScrolling(tmuxSession);
      } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
    }
    const activePaneId = process.env.TMUX_PANE?.trim();
    if (activePaneId) { try { execFileSync("tmux", ["display-message", "-p", "-t", activePaneId, "#S"], { encoding: "utf-8" }); } catch {} }
    try { withTmuxExtendedKeys(cwd, () => { runCodexBlocking(cwd, launchBinary, translatedLaunchArgs, codexEnvWithNotify); }); } finally {
      const cleanupPaneIds = buildHudPaneCleanupTargets(listHudWatchPaneIdsInCurrentWindow(currentPaneId), hudPaneId, currentPaneId);
      for (const paneId of cleanupPaneIds) killTmuxPane(paneId);
    }
  } else if (launchPolicy === "direct") {
    runCodexBlocking(cwd, launchBinary, translatedLaunchArgs, codexEnvWithNotify);
  } else {
    // detached-tmux
    const codexCmd = buildTmuxPaneCommand(launchBinary, translatedLaunchArgs);
    const detachedWindowsCodexCmd = nativeWindows ? buildWindowsPromptCommand(launchBinary, translatedLaunchArgs) : null;
    const sessionName = buildDetachedTmuxSessionName(cwd, sessionId);
    let createdDetachedSession = false;
    let registeredHookTarget: string | null = null;
    let registeredHookName: string | null = null;
    let registeredClientAttachedHookName: string | null = null;
    try {
      const bootstrapSteps = buildDetachedSessionBootstrapSteps(sessionName, cwd, codexCmd, hudCmd, workerLaunchArgs, codexHomeOverride, notifyTempContractRaw, nativeWindows, sessionId, leaderCli);
      // Labeled outer loop: a no-controlling-tty attach failure must abort
      // BOTH the finalize sub-steps and the outer bootstrap step iteration
      // without falling through to rollback, so the detached session stays
      // alive for the user to manually attach.
      stepLoop: for (const step of bootstrapSteps) {
        let output = "";
        try {
          output = execFileSync("tmux", step.args, { stdio: "pipe", encoding: "utf-8" });
        } catch (err) {
          throw new Error(formatDetachedTmuxStepFailure(step, err));
        }
        if (step.name === "new-session") { createdDetachedSession = true; parsePaneIdFromTmuxOutput(output || ""); }
        if (step.name === "split-and-capture-hud-pane") {
          const hudPaneId = parsePaneIdFromTmuxOutput(output || "");
          const hookWindowIndex = hudPaneId ? detectDetachedSessionWindowIndex(sessionName) : null;
          const hookTarget = hudPaneId && hookWindowIndex ? buildResizeHookTarget(sessionName, hookWindowIndex) : null;
          const hookName = hudPaneId && hookWindowIndex ? buildResizeHookName("launch", sessionName, hookWindowIndex, hudPaneId) : null;
          const clientAttachedHookName = hudPaneId && hookWindowIndex ? buildClientAttachedReconcileHookName("launch", sessionName, hookWindowIndex, hudPaneId) : null;
          const finalizeSteps = buildDetachedSessionFinalizeSteps(sessionName, hudPaneId, hookWindowIndex, process.env.OMB_MOUSE !== "0", nativeWindows);
          if (nativeWindows && detachedWindowsCodexCmd) scheduleDetachedWindowsCodexLaunch(sessionName, detachedWindowsCodexCmd);
          for (const finalizeStep of finalizeSteps) {
            const stdio = finalizeStep.name === "attach-session" ? "inherit" : "ignore";
            try { execFileSync("tmux", finalizeStep.args, { stdio }); } catch (err) {
              const detail = formatDetachedTmuxStepFailure(finalizeStep, err);
              process.stderr.write(`[cli/index] operation failed: ${detail}\n`);
              if (finalizeStep.name === "attach-session") {
                // No-controlling-terminal: keep the detached session alive and
                // tell the user how to attach manually. Skips rollback and the
                // direct-mode fallback below — re-launching the leader in
                // direct mode would create a second leader writing to the
                // same workspace.
                if (isNoControllingTtyError(err)) {
                  for (const line of buildManualAttachInstructionLines(sessionName)) {
                    process.stderr.write(`${line}\n`);
                  }
                  break stepLoop;
                }
                throw new Error(detail);
              }
              continue;
            }
            if (finalizeStep.name === "register-resize-hook" && hookTarget && hookName) { registeredHookTarget = hookTarget; registeredHookName = hookName; }
            if (finalizeStep.name === "register-client-attached-reconcile" && clientAttachedHookName) { registeredClientAttachedHookName = clientAttachedHookName; }
          }
        }
      }
    } catch (err) {
      process.stderr.write(`[cli/index] operation failed: ${err}\n`);
      if (createdDetachedSession) {
        const rollbackSteps = buildDetachedSessionRollbackSteps(sessionName, registeredHookTarget, registeredHookName, registeredClientAttachedHookName);
        for (const rollbackStep of rollbackSteps) { try { execFileSync("tmux", rollbackStep.args, { stdio: "ignore" }); } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); } }
      }
      runCodexBlocking(cwd, launchBinary, translatedLaunchArgs, codexEnvWithNotify);
    }
  }
}

/**
 * postLaunch: Clean up after Codex exits.
 * Each step is independently fault-tolerant (try/catch per step).
 */
async function postLaunch(
  cwd: string,
  sessionId: string,
  codexHomeOverride?: string,
  enableNotifyFallbackAuthority: boolean = false,
  leaderCli: LeaderCli = "codebuddy",
): Promise<void> {
  let sessionStartedAt: string | undefined;
  try { const sessionState = await readSessionState(cwd); sessionStartedAt = sessionState?.started_at; } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
  await reapPostLaunchOrphanedMcpProcesses();
  try { await flushNotifyFallbackOnce(cwd, { codexHomeOverride, enableAuthority: enableNotifyFallbackAuthority, sessionId, leaderCli }); } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
  try { await stopNotifyFallbackWatcher(cwd); } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
  try { await flushHookDerivedWatcherOnce(cwd); } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
  try { await stopHookDerivedWatcher(cwd); } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
  try { await removeSessionModelInstructionsFile(cwd, sessionId); } catch (err) { console.error(`[omb] postLaunch: model instructions cleanup failed: ${err instanceof Error ? err.message : err}`); }
  try { await writeSessionEnd(cwd, sessionId); } catch (err) { console.error(`[omb] postLaunch: session archive failed: ${err instanceof Error ? err.message : err}`); }
  try { await cleanupPostLaunchModeStateFiles(cwd, sessionId); } catch (err) { console.error(`[omb] postLaunch: mode cleanup failed: ${err instanceof Error ? err.message : err}`); }
  try {
    const { notifyLifecycle } = await import("../../notifications/index.js");
    const durationMs = sessionStartedAt ? Date.now() - new Date(sessionStartedAt).getTime() : undefined;
    await notifyLifecycle("session-end", { sessionId, projectPath: cwd, projectName: basename(cwd), durationMs, reason: "session_exit" });
  } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
  try {
    const { markOwnedTeamsLeaderSessionStopped } = await import("../../team/state.js");
    await markOwnedTeamsLeaderSessionStopped(cwd, sessionId);
  } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
  try {
    const durationMs = sessionStartedAt ? Date.now() - new Date(sessionStartedAt).getTime() : undefined;
    const normalizedEvent = process.exitCode && process.exitCode !== 0 ? "failed" : "finished";
    const errorSummary = normalizedEvent === "failed" ? `codebuddy exited with code ${process.exitCode}` : undefined;
    await emitNativeHookEvent(cwd, "session-end", {
      session_id: sessionId,
      context: buildNativeHookBaseContext(cwd, sessionId, normalizedEvent, {
        project_path: cwd, project_name: basename(cwd), duration_ms: durationMs, reason: "session_exit",
        status: normalizedEvent === "failed" ? "failed" : "finished",
        ...(process.exitCode !== undefined ? { exit_code: process.exitCode } : {}),
        ...(errorSummary ? { error_summary: errorSummary } : {}),
      }),
    });
  } catch (err) { process.stderr.write(`[cli/index] operation failed: ${err}\n`); }
}

// ── Public pipeline entry points ───────────────────────────────────────────

/**
 * Execute the full launch pipeline with HUD support.
 */
export async function launchWithHud(args: string[]): Promise<void> {
  if (isNativeWindows()) {
    const { result } = spawnPlatformCommandSync("tmux", ["-V"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    if (result.error) {
      const errno = result.error as NodeJS.ErrnoException;
      const kind = classifySpawnError(errno);
      if (kind === "missing") {
        console.warn("[omb] warning: tmux was not found on native Windows. Continuing without tmux/HUD.\n[omb] To enable tmux-backed features, install psmux:\n[omb]   winget install psmux\n[omb] See: https://github.com/marlocarlo/psmux");
      } else {
        console.warn(`[omb] warning: tmux probe failed on native Windows (${errno.code || errno.message}). Continuing without tmux/HUD.`);
      }
    } else if (result.status !== 0 && !isTmuxAvailable()) {
      const stderr = (result.stderr || "").trim();
      console.warn(`[omb] warning: tmux reported an error on native Windows${stderr ? ` (${stderr})` : ""}. Continuing without tmux/HUD.`);
    }
  }

  const launchCwd = process.cwd();
  const defaultLeaderCli = args[0] === "resume"
    ? (readPersistedResumeLeaderCli(launchCwd) ?? "codebuddy")
    : "codebuddy";
  const leaderCliResult = extractLeaderCliArgs(args, process.env, defaultLeaderCli);
  const parsedWorktree = parseWorktreeMode(leaderCliResult.remainingArgs);
  const notifyTempResult = resolveNotifyTempContract(parsedWorktree.remainingArgs, process.env);
  const explicitLaunchPolicy = resolveLeaderLaunchPolicyOverride(notifyTempResult.passthroughArgs);
  const codexHomeOverride = resolveCodexHomeForLaunch(
    launchCwd,
    process.env,
    leaderCliResult.leaderCli,
  );
  const launchPolicy = resolveCodexLaunchPolicy(process.env, process.platform, undefined, isNativeWindows(), undefined, undefined, explicitLaunchPolicy);
  const enableNotifyFallbackAuthority = launchPolicy === "direct";
  const workerSparkModel = resolveWorkerSparkModel(notifyTempResult.passthroughArgs, codexHomeOverride);
  const normalizedArgs = normalizeLeaderLaunchArgs(notifyTempResult.passthroughArgs, leaderCliResult.leaderCli);
  let cwd = launchCwd;
  if (parsedWorktree.mode.enabled) {
    const planned = planWorktreeTarget({ cwd: launchCwd, scope: "launch", mode: parsedWorktree.mode });
    const ensured = ensureWorktree(planned);
    if (ensured.enabled) cwd = ensured.worktreePath;
  }
  const sessionId = `omb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await preflight(cwd);

  try { await preLaunch(cwd, sessionId, notifyTempResult.contract, codexHomeOverride, enableNotifyFallbackAuthority, leaderCliResult.leaderCli); } catch (err) {
    console.error(`[omb] preLaunch warning: ${err instanceof Error ? err.message : err}`);
  }

  try {
    const notifyTempContractRaw = notifyTempResult.contract.active ? serializeNotifyTempContract(notifyTempResult.contract) : null;
    runCodex(cwd, normalizedArgs, sessionId, leaderCliResult.leaderCli, workerSparkModel, codexHomeOverride, notifyTempContractRaw, explicitLaunchPolicy);
  } finally {
    await postLaunch(cwd, sessionId, codexHomeOverride, enableNotifyFallbackAuthority, leaderCliResult.leaderCli);
  }
}

/**
 * Execute with overlay injection for `omb exec`.
 */
export async function execWithOverlay(args: string[]): Promise<void> {
  const launchCwd = process.cwd();
  const leaderCliResult = extractLeaderCliArgs(args, process.env);
  const parsedWorktree = parseWorktreeMode(leaderCliResult.remainingArgs);
  const notifyTempResult = resolveNotifyTempContract(parsedWorktree.remainingArgs, process.env);
  const codexHomeOverride = resolveCodexHomeForLaunch(
    launchCwd,
    process.env,
    leaderCliResult.leaderCli,
  );
  const normalizedArgs = normalizeLeaderLaunchArgs(notifyTempResult.passthroughArgs, leaderCliResult.leaderCli);
  let cwd = launchCwd;

  if (parsedWorktree.mode.enabled) {
    const planned = planWorktreeTarget({ cwd: launchCwd, scope: "launch", mode: parsedWorktree.mode });
    const ensured = ensureWorktree(planned);
    if (ensured.enabled) cwd = ensured.worktreePath;
  }

  const sessionId = `omb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await preflight(cwd);

  try { await preLaunch(cwd, sessionId, notifyTempResult.contract, codexHomeOverride, true, leaderCliResult.leaderCli); } catch (err) {
    console.error(`[omb] preLaunch warning: ${err instanceof Error ? err.message : err}`);
  }

  try {
    const notifyTempContractRaw = notifyTempResult.contract.active ? serializeNotifyTempContract(notifyTempResult.contract) : null;
    const codexArgs = injectLeaderModelInstructionsBypassArgs(cwd, translateLeaderExecArgs(normalizedArgs, leaderCliResult.leaderCli), leaderCliResult.leaderCli, process.env, sessionModelInstructionsPath(cwd, sessionId));
    const codexEnvBase = buildProviderLeaderEnv(process.env, leaderCliResult.leaderCli, codexHomeOverride);
    const codexEnv = notifyTempContractRaw ? { ...codexEnvBase, [OMB_NOTIFY_TEMP_CONTRACT_ENV]: notifyTempContractRaw } : codexEnvBase;
    runCodexBlocking(cwd, resolveLeaderCliBinary(leaderCliResult.leaderCli), codexArgs, codexEnv);
  } finally {
    await postLaunch(cwd, sessionId, codexHomeOverride, true, leaderCliResult.leaderCli);
  }
}

/**
 * Execute the launch pipeline with explicit context (for programmatic use).
 */
export async function executeLaunchPipeline(
  _ctx: CliBootstrapContext,
  command: string,
  args: string[],
): Promise<LaunchPipelineResult> {
  try {
    if (command === "launch") {
      await launchWithHud(args);
    } else if (command === "resume") {
      await launchWithHud(["resume", ...args]);
    } else if (command === "exec") {
      await execWithOverlay(args);
    } else {
      return { exitCode: 1, error: { kind: "usage" as const, message: `launch pipeline does not handle command: ${command}`, exitCode: 1 } };
    }
    return { exitCode: typeof process.exitCode === "string" ? parseInt(process.exitCode, 10) : (typeof process.exitCode === "number" ? process.exitCode : 0) };
  } catch (err) {
    const classified = classifyCliError(err);
    return { exitCode: classified.exitCode, error: classified };
  }
}
