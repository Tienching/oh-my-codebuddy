import type { LeaderCli } from "./runtime/launch-pipeline.js";
import { buildDetachedTmuxSessionName, parseLeaderCliValue } from "./runtime/launch-pipeline.js";
import { createHandoffArtifact } from "../handoff/artifacts.js";
import type { HandoffArtifactRecord, HandoffRequest } from "../handoff/contract.js";
import { renderHandoffReview, resolveHandoffArtifactRef, reviewHandoff, type ResolvedHandoffArtifact } from "../review/handoff-review.js";
import { readLeaderSwitchState, writeLeaderSwitchState, type LeaderSwitchState } from "../switch/state.js";
import { isSessionStale, readSessionState, type SessionState } from "../hooks/session.js";
import { formatCliText } from "./brand.js";
import { CODEBUDDY_BYPASS_FLAG, CODEBUDDY_LEGACY_BYPASS_FLAG, MADMAX_FLAG, MADMAX_SPARK_FLAG } from "./constants.js";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const HELP = formatCliText([
  "Usage: {cmd} switch --to <codebuddy|codex|claude> [--handoff <latest|id|path>] [--reason <text>] [--task <text>] [--dry-run] [--launch]",
  "       {cmd} switch status",
  "",
  "Prepare an artifact-based provider leader switch. This never hot-swaps the current process; inside tmux it can smooth-take over the current tmux session by opening a new target window and switching the client after a short countdown.",
  "",
  "Options:",
  "  --to <leader>      Target leader provider: codebuddy | codex | claude",
  "  --handoff <ref>    Use existing handoff ref instead of creating a new one",
  "  --reason <text>    Reason for a newly generated handoff",
  "  --task <text>      Task summary for a newly generated handoff",
  "  --dry-run          Print plan without writing state or launching",
  "  --launch           Explicitly launch the target leader with the handoff prompt",
  "  --help, -h         Show this help",
].join("\n"));

export interface SwitchCommandDependencies {
  cwd?: string;
  stdout?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  launch?: HandoffSessionLauncher;
}

export interface HandoffSessionLaunchInput {
  cwd: string;
  to: LeaderCli;
  prompt: string;
  handoffId: string;
  leaderLaunchArgs: string[];
}

export interface HandoffSessionLaunchResult {
  sessionId: string;
  sessionName: string;
  takeoverPromptPath: string;
  launchCommand: string;
  sameTmuxSession?: boolean;
  oldWindowTarget?: string;
  newWindowTarget?: string;
}

export type HandoffSessionLauncher = (input: HandoffSessionLaunchInput) => Promise<HandoffSessionLaunchResult>;

interface CurrentTmuxClientContext {
  sessionName: string;
  windowIndex: string;
  paneId: string;
  windowTarget: string;
}

class SameSessionTakeoverSideEffectError extends Error {
  readonly createdWindowTarget?: string;

  constructor(message: string, createdWindowTarget?: string) {
    super(message);
    this.name = "SameSessionTakeoverSideEffectError";
    this.createdWindowTarget = createdWindowTarget;
  }
}

const SAME_SESSION_SWITCH_COUNTDOWN_MS = 5_000;
const SAME_SESSION_STARTUP_POLL_MS = 2_000;
const SAME_SESSION_STARTUP_POLL_INTERVAL_MS = 100;

interface ParsedSwitchArgs {
  action: "prepare" | "status" | "help";
  to?: LeaderCli;
  handoffRef?: string;
  reason?: string;
  task?: string;
  mode?: HandoffRequest["mode"];
  dryRun: boolean;
  launch: boolean;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value after ${flag}`);
  return value;
}

function parseMode(value: string): HandoffRequest["mode"] {
  if (["solo", "ralph", "team", "autopilot", "unknown"].includes(value)) return value as HandoffRequest["mode"];
  throw new Error("Invalid --mode value. Expected one of: solo, ralph, team, autopilot, unknown");
}

export function parseSwitchArgs(args: string[]): ParsedSwitchArgs {
  if (args.length === 0 || args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return { action: "help", dryRun: false, launch: false };
  }
  if (args[0] === "status") return { action: "status", dryRun: false, launch: false };
  let to: LeaderCli | undefined;
  let handoffRef: string | undefined;
  let reason: string | undefined;
  let task: string | undefined;
  let mode: HandoffRequest["mode"];
  let dryRun = false;
  let shouldLaunch = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--launch") { shouldLaunch = true; continue; }
    if (arg === "--to") { to = parseLeaderCliValue(readValue(args, i, arg), "--to"); i += 1; continue; }
    if (arg.startsWith("--to=")) { to = parseLeaderCliValue(arg.slice("--to=".length), "--to"); continue; }
    if (arg === "--handoff") { handoffRef = readValue(args, i, arg); i += 1; continue; }
    if (arg.startsWith("--handoff=")) { handoffRef = arg.slice("--handoff=".length); continue; }
    if (arg === "--reason") { reason = readValue(args, i, arg); i += 1; continue; }
    if (arg === "--task") { task = readValue(args, i, arg); i += 1; continue; }
    if (arg === "--mode") { mode = parseMode(readValue(args, i, arg)); i += 1; continue; }
    throw new Error(`Unknown switch argument: ${arg}`);
  }
  if (!to) throw new Error("Missing --to leader. Expected one of: codebuddy, codex, claude");
  return { action: "prepare", to, handoffRef, reason, task, mode, dryRun, launch: shouldLaunch };
}

function buildSwitchPrompt(markdown: string): string {
  return [
    "You are taking over as the OMB leader provider from a handoff artifact.",
    "Do not assume prior transcript access. Read .omb/handoffs/latest.md as the source of truth, inspect mentioned files, and continue safely.",
    "The handoff content below is copied from .omb/handoffs/latest.md.",
    "",
    markdown,
  ].join("\n");
}

function buildLaunchCommand(to: LeaderCli, leaderLaunchArgs: readonly string[] = []): string {
  return ["omb", "--leader-cli", to, ...leaderLaunchArgs].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function tmuxSync(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readCurrentTmuxClientContext(): CurrentTmuxClientContext | undefined {
  const tmuxPaneTarget = process.env.TMUX_PANE?.trim();
  const output = tmuxSync(
    tmuxPaneTarget
      ? ["display-message", "-p", "-t", tmuxPaneTarget, "#S\t#I\t#{pane_id}"]
      : ["display-message", "-p", "#S\t#I\t#{pane_id}"],
  );
  const [sessionName = "", windowIndex = "", paneId = ""] = output.split("\t");
  if (!sessionName || !windowIndex || !paneId.startsWith("%")) return undefined;
  return {
    sessionName,
    windowIndex,
    paneId,
    windowTarget: `${sessionName}:${windowIndex}`,
  };
}

function sameSessionSwitchCountdownMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OMB_SWITCH_COUNTDOWN_MS;
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return SAME_SESSION_SWITCH_COUNTDOWN_MS;
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildLeaderCommand(
  to: LeaderCli,
  leaderLaunchArgs: readonly string[],
  takeoverPromptPath: string,
): string {
  const inheritedArgSegment = leaderLaunchArgs.map((arg) => shellQuote(arg)).join(" ");
  return `exec omb --leader-cli ${shellQuote(to)}${inheritedArgSegment ? ` ${inheritedArgSegment}` : ""} "$(cat ${shellQuote(takeoverPromptPath)})"`;
}

function buildWindowName(to: LeaderCli, sessionId: string): string {
  return `handoff-${to}-${sessionId.slice(-6)}`;
}

async function waitForTmuxPaneStartup(target: string): Promise<void> {
  const deadline = Date.now() + SAME_SESSION_STARTUP_POLL_MS;
  while (Date.now() < deadline) {
    try {
      const output = tmuxSync(["display-message", "-p", "-t", target, "#{pane_dead}\t#{pane_pid}\t#{pane_current_command}"]);
      const [paneDead = "", panePid = "", currentCommand = ""] = output.split("\t");
      if (paneDead === "1") {
        throw new Error(`target pane exited before takeover completed (${currentCommand || "unknown"})`);
      }
      if (panePid.trim() !== "" && currentCommand.trim() !== "") return;
    } catch (error) {
      if (error instanceof Error && /target pane exited/i.test(error.message)) throw error;
    }
    await sleep(SAME_SESSION_STARTUP_POLL_INTERVAL_MS);
  }
}

function cleanupOrphanTmuxWindow(target: string): string {
  try {
    execFileSync("tmux", ["kill-window", "-t", target], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return `Cleaned orphan window ${target}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/can't find window|can't find session|no such (window|session)/i.test(message)) {
      return `Orphan window ${target} was already gone.`;
    }
    return `Orphan window cleanup failed for ${target}. Remove it manually with: tmux kill-window -t ${target}. Cleanup cause: ${message}`;
  }
}

function sessionCmdlineRequestsBypass(cmdline: string | null | undefined): boolean {
  const normalized = ` ${(cmdline ?? "").replace(/\s+/g, " ").trim()} `;
  if (normalized === "  ") return false;
  return [
    new RegExp(` ${MADMAX_FLAG}(?: |$)`),
    new RegExp(` ${MADMAX_SPARK_FLAG}(?: |$)`),
    new RegExp(` ${CODEBUDDY_LEGACY_BYPASS_FLAG}(?: |$)`),
    new RegExp(` ${CODEBUDDY_BYPASS_FLAG}(?: |$)`),
    / --permission-mode(?:=|\s+)bypassPermissions(?: |$)/,
  ].some((pattern) => pattern.test(normalized));
}

async function inferInheritedLeaderLaunchArgs(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const currentSessionId = typeof env.OMB_SESSION_ID === "string"
    ? env.OMB_SESSION_ID.trim()
    : "";
  const session = await readSessionState(cwd);
  if (!session) return [];
  if (!sessionBelongsToCurrentRuntime(session, cwd, currentSessionId)) return [];
  return sessionCmdlineRequestsBypass(session.pid_cmdline) ? [MADMAX_FLAG] : [];
}

function sessionBelongsToCurrentRuntime(
  session: SessionState,
  cwd: string,
  currentSessionId: string,
): boolean {
  if (currentSessionId && session.session_id === currentSessionId) return true;
  if (session.cwd && session.cwd !== cwd) return false;

  try {
    return !isSessionStale(session);
  } catch {
    return false;
  }
}

function displayPath(cwd: string, path: string): string {
  const relativePath = relative(cwd, path);
  return relativePath.startsWith("..") ? path : relativePath;
}

function buildHandoffSessionId(): string {
  return `omb-handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function launchDetachedHandoffSession(input: HandoffSessionLaunchInput): Promise<HandoffSessionLaunchResult> {
  const sessionId = buildHandoffSessionId();
  const sessionName = buildDetachedTmuxSessionName(input.cwd, sessionId);
  const takeoverPromptPath = join(input.cwd, ".omb", "handoffs", `${input.handoffId}-takeover-prompt.md`);
  await mkdir(dirname(takeoverPromptPath), { recursive: true });
  await writeFile(takeoverPromptPath, input.prompt, "utf-8");

  const leaderCommand = buildLeaderCommand(input.to, input.leaderLaunchArgs, takeoverPromptPath);
  const tmuxShellCommand = `bash -lc ${shellQuote(leaderCommand)}`;
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", input.cwd, tmuxShellCommand], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not launch tmux-backed handoff session. Handoff artifacts remain available; takeover prompt: ${takeoverPromptPath}. Cause: ${message}`);
  }

  return {
    sessionId,
    sessionName,
    takeoverPromptPath,
    launchCommand: `tmux attach -t ${sessionName}`,
  };
}

export async function launchSameTmuxSessionHandoffSession(input: HandoffSessionLaunchInput): Promise<HandoffSessionLaunchResult> {
  const context = readCurrentTmuxClientContext();
  if (!context) throw new Error("current tmux client context is not available");

  const sessionId = buildHandoffSessionId();
  const takeoverPromptPath = join(input.cwd, ".omb", "handoffs", `${input.handoffId}-takeover-prompt.md`);
  await mkdir(dirname(takeoverPromptPath), { recursive: true });
  await writeFile(takeoverPromptPath, input.prompt, "utf-8");

  const leaderCommand = buildLeaderCommand(input.to, input.leaderLaunchArgs, takeoverPromptPath);
  const tmuxShellCommand = `bash -lc ${shellQuote(leaderCommand)}`;
  const windowName = buildWindowName(input.to, sessionId);
  const output = tmuxSync([
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{window_index}\t#{pane_id}",
    "-t",
    context.sessionName,
    "-n",
    windowName,
    "-c",
    input.cwd,
    tmuxShellCommand,
  ]);
  const [windowIndex = "", paneId = ""] = output.split("\t");
  const newWindowTarget = windowIndex ? `${context.sessionName}:${windowIndex}` : undefined;
  if (!windowIndex || !paneId.startsWith("%")) {
    const cleanupSummary = newWindowTarget
      ? cleanupOrphanTmuxWindow(newWindowTarget)
      : "Could not determine orphan window target for cleanup; inspect tmux windows manually.";
    throw new SameSessionTakeoverSideEffectError(
      `same-session tmux takeover returned unparseable new-window output. ${cleanupSummary} Raw output: ${output}`,
      newWindowTarget,
    );
  }
  const parsedNewWindowTarget = `${context.sessionName}:${windowIndex}`;

  try {
    await waitForTmuxPaneStartup(paneId);

    const countdownMs = sameSessionSwitchCountdownMs();
    const countdownSeconds = Math.ceil(countdownMs / 1000);
    const countdownMessage = countdownSeconds > 0
      ? `${input.to} ready in ${parsedNewWindowTarget}; switching current tmux session in ${countdownSeconds}s. Previous leader window preserved at ${context.windowTarget}.`
      : `${input.to} ready in ${parsedNewWindowTarget}; switching current tmux session now. Previous leader window preserved at ${context.windowTarget}.`;
    try {
      execFileSync("tmux", ["display-message", "-t", context.paneId, "--", countdownMessage], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // best-effort only
    }
    if (countdownMs > 0) await sleep(countdownMs);
    execFileSync("tmux", ["select-window", "-t", parsedNewWindowTarget], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error instanceof SameSessionTakeoverSideEffectError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const cleanupSummary = cleanupOrphanTmuxWindow(parsedNewWindowTarget);
    throw new SameSessionTakeoverSideEffectError(
      `same-session tmux takeover created ${parsedNewWindowTarget} but did not complete automatic switch. ${cleanupSummary} Original cause: ${message}`,
      parsedNewWindowTarget,
    );
  }

  return {
    sessionId,
    sessionName: context.sessionName,
    takeoverPromptPath,
    launchCommand: `tmux select-window -t ${parsedNewWindowTarget}`,
    sameTmuxSession: true,
    oldWindowTarget: context.windowTarget,
    newWindowTarget: parsedNewWindowTarget,
  };
}

export async function launchHandoffSession(input: HandoffSessionLaunchInput): Promise<HandoffSessionLaunchResult> {
  try {
    if (process.env.TMUX) {
      const context = readCurrentTmuxClientContext();
      if (context) return await launchSameTmuxSessionHandoffSession(input);
    }
  } catch (error) {
    if (error instanceof SameSessionTakeoverSideEffectError) throw error;
    // fall through to detached-session fallback only when same-session launch had no tmux-side effects yet
  }
  return launchDetachedHandoffSession(input);
}

function assertTargetMatches(record: HandoffArtifactRecord, to: LeaderCli): void {
  if (record.to_provider !== to) {
    throw new Error(`Selected handoff ${record.id} targets ${record.to_provider}, not ${to}. Create a new handoff or choose the matching provider.`);
  }
}

async function selectOrCreateHandoff(cwd: string, parsed: ParsedSwitchArgs): Promise<{ artifact: ResolvedHandoffArtifact; created: boolean; markdown: string }> {
  if (!parsed.to) throw new Error("Missing --to leader. Expected one of: codebuddy, codex, claude");
  if (parsed.handoffRef) {
    const artifact = resolveHandoffArtifactRef(cwd, parsed.handoffRef);
    assertTargetMatches(artifact.record, parsed.to);
    return { artifact, created: false, markdown: artifact.markdown };
  }
  const result = await createHandoffArtifact({ cwd, to: parsed.to, reason: parsed.reason, task: parsed.task, mode: parsed.mode, dryRun: parsed.dryRun });
  return {
    artifact: { record: result.record, context: result.context, warnings: result.warnings, markdown: result.markdown, jsonPath: result.record.json_path, markdownPath: result.record.markdown_path },
    created: true,
    markdown: result.markdown,
  };
}

async function statusCommand(cwd: string, stdout: (line: string) => void): Promise<void> {
  const warnings: string[] = [];
  const state = readLeaderSwitchState(cwd, warnings);
  if (!state) {
    stdout(warnings.length > 0 ? warnings.join("\n") : "No provider switch state.");
    return;
  }
  stdout([
    `target_leader: ${state.target_leader}`,
    `handoff_id: ${state.handoff_id}`,
    `handoff_in_progress: ${state.handoff_in_progress}`,
    state.handoff_phase ? `handoff_phase: ${state.handoff_phase}` : undefined,
    `created_at: ${state.created_at}`,
    state.old_session_id ? `old_session_id: ${state.old_session_id}` : undefined,
    state.new_session_id ? `new_session_id: ${state.new_session_id}` : undefined,
    state.new_session_name ? `new_session_name: ${state.new_session_name}` : undefined,
    state.old_window_target ? `old_window_target: ${state.old_window_target}` : undefined,
    state.new_window_target ? `new_window_target: ${state.new_window_target}` : undefined,
    typeof state.same_tmux_session === "boolean" ? `same_tmux_session: ${state.same_tmux_session}` : undefined,
    state.takeover_prompt_path ? `takeover_prompt_path: ${state.takeover_prompt_path}` : undefined,
    state.launch_command ? `launch_command: ${state.launch_command}` : undefined,
  ].filter(Boolean).join("\n"));
}

export async function switchCommand(args: string[], deps: SwitchCommandDependencies = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const launch = deps.launch ?? launchHandoffSession;
  const env = deps.env ?? process.env;
  const parsed = parseSwitchArgs(args);
  if (parsed.action === "help") { stdout(HELP); return; }
  if (parsed.action === "status") { await statusCommand(cwd, stdout); return; }
  if (!parsed.to) throw new Error("Missing --to leader. Expected one of: codebuddy, codex, claude");

  const selected = await selectOrCreateHandoff(cwd, parsed);
  const review = reviewHandoff(selected.artifact);
  if (review.verdict === "reject") {
    throw new Error(`Handoff is not switch-ready.\n${renderHandoffReview(review)}`);
  }
  const inheritedLeaderLaunchArgs = await inferInheritedLeaderLaunchArgs(cwd, env);
  const launchCommand = buildLaunchCommand(parsed.to, inheritedLeaderLaunchArgs);
  const prompt = buildSwitchPrompt(selected.markdown);

  if (parsed.dryRun) {
    stdout([
      "Switch dry run",
      selected.created ? `Would create handoff: ${selected.artifact.record.id}` : `Selected handoff: ${selected.artifact.record.id}`,
      `Target leader: ${parsed.to}`,
      `Review verdict: ${review.verdict}`,
      `Would run: ${launchCommand}`,
      "Prompt preview:",
      prompt.slice(0, 2000),
    ].join("\n"));
    return;
  }

  const activeLeader = ["codebuddy", "codex", "claude"].includes(selected.artifact.record.from_provider)
    ? selected.artifact.record.from_provider as LeaderCli
    : "unknown";
  const preparedAt = new Date().toISOString();
  const oldSessionId = typeof env.OMB_SESSION_ID === "string" && env.OMB_SESSION_ID.trim()
    ? env.OMB_SESSION_ID.trim()
    : undefined;
  const preparedState: LeaderSwitchState = {
    active_leader: activeLeader,
    target_leader: parsed.to,
    handoff_id: selected.artifact.record.id,
    handoff_in_progress: true,
    handoff_phase: "prepared",
    created_at: preparedAt,
    old_session_id: oldSessionId,
    launch_command: launchCommand,
  };

  await writeLeaderSwitchState(cwd, preparedState);

  if (parsed.launch) {
    const launched = await launch({
      cwd,
      to: parsed.to,
      prompt,
      handoffId: selected.artifact.record.id,
      leaderLaunchArgs: inheritedLeaderLaunchArgs,
    });
    await writeLeaderSwitchState(cwd, {
      ...preparedState,
      handoff_phase: "launched",
      new_session_id: launched.sessionId,
      new_session_name: launched.sessionName,
      old_window_target: launched.oldWindowTarget,
      new_window_target: launched.newWindowTarget,
      same_tmux_session: launched.sameTmuxSession,
      takeover_prompt_path: launched.takeoverPromptPath,
      launch_command: launched.launchCommand,
      launched_at: new Date().toISOString(),
    });
    const launchSummary = launched.sameTmuxSession
      ? `Current tmux session switched to new ${parsed.to} window ${launched.newWindowTarget}. Previous leader window preserved at ${launched.oldWindowTarget}. Revisit with: ${launched.launchCommand}. I will stop editing in this session now.`
      : `New ${parsed.to} session is ready: ${launched.sessionName}. Switch with: tmux switch-client -t ${launched.sessionName} or attach with: tmux attach -t ${launched.sessionName}. I will stop editing in this session now.`;
    stdout([
      `Launched switch: ${selected.artifact.record.id}`,
      `Target leader: ${parsed.to}`,
      `Review verdict: ${review.verdict}`,
      `Takeover prompt: ${displayPath(cwd, launched.takeoverPromptPath)}`,
      launchSummary,
    ].join("\n"));
    return;
  }

  stdout([
    `Prepared switch: ${selected.artifact.record.id}`,
    `Target leader: ${parsed.to}`,
    `Review verdict: ${review.verdict}`,
    `Handoff artifact: ${displayPath(cwd, selected.artifact.record.markdown_path)}`,
    "Latest: .omb/handoffs/latest.md",
    `Next: ${launchCommand}`,
    "Launch not started. Re-run with --launch to start a new target-provider session.",
  ].join("\n"));
}
