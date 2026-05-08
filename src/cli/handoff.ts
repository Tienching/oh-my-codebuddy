import { relative } from "node:path";
import { createHandoffArtifact, readHandoffIndex, readLatestHandoffMarkdown } from "../handoff/artifacts.js";
import { HANDOFF_PROVIDERS, parseHandoffProvider, type HandoffProvider, type HandoffRequest } from "../handoff/contract.js";
import { formatCliText } from "./brand.js";

const HELP = formatCliText([
  "Usage: {cmd} handoff --to <codebuddy|codex|claude|gemini> [--reason <text>] [--task <text>] [--dry-run]",
  "       {cmd} handoff <codebuddy|codex|claude|gemini> [--reason <text>] [--task <text>] [--dry-run]",
  "       {cmd} handoff list",
  "       {cmd} handoff show latest",
  "",
  "Create provider-neutral OMB handoff artifacts under .omb/handoffs/.",
  "",
  "Options:",
  "  --to <provider>      Target provider: codebuddy | codex | claude | gemini",
  "  --from <provider>    Source provider when known",
  "  --reason <text>      Why this handoff is being created",
  "  --task <text>        Current task summary for the target provider",
  "  --mode <mode>        solo | ralph | team | autopilot | unknown",
  "  --dry-run            Print the handoff markdown without writing files",
  "  --help, -h           Show this help",
  "",
  "Examples:",
  "  {cmd} handoff claude",
  "  {cmd} handoff --to codex --reason \"test repair\"",
  "  {cmd} handoff --to claude --task \"continue payment webhook work\"",
].join("\n"));

export interface HandoffCommandDependencies {
  cwd?: string;
  stdout?: (line: string) => void;
}

interface ParsedHandoffArgs {
  action: "create" | "list" | "show" | "help";
  showTarget?: "latest";
  to?: HandoffProvider;
  from?: HandoffProvider;
  reason?: string;
  task?: string;
  mode?: HandoffRequest["mode"];
  dryRun: boolean;
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

export function parseHandoffArgs(args: string[]): ParsedHandoffArgs {
  if (args.length === 0 || args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return { action: "help", dryRun: false };
  }
  if (args[0] === "list") return { action: "list", dryRun: false };
  if (args[0] === "show") {
    if (args[1] !== "latest") throw new Error("Usage: omb handoff show latest");
    return { action: "show", showTarget: "latest", dryRun: false };
  }

  let to: HandoffProvider | undefined;
  let from: HandoffProvider | undefined;
  let reason: string | undefined;
  let task: string | undefined;
  let mode: HandoffRequest["mode"];
  let dryRun = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--to") {
      to = parseHandoffProvider(readValue(args, i, arg), "--to");
      i += 1;
      continue;
    }
    if (arg.startsWith("--to=")) {
      to = parseHandoffProvider(arg.slice("--to=".length), "--to");
      continue;
    }
    if (arg === "--from") {
      from = parseHandoffProvider(readValue(args, i, arg), "--from");
      i += 1;
      continue;
    }
    if (arg === "--reason") {
      reason = readValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--task") {
      task = readValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--mode") {
      mode = parseMode(readValue(args, i, arg));
      i += 1;
      continue;
    }
    if (!arg.startsWith("--") && !to) {
      to = parseHandoffProvider(arg, "--to");
      continue;
    }
    throw new Error(`Unknown handoff argument: ${arg}`);
  }

  if (!to) throw new Error(`Missing --to provider. Expected one of: ${HANDOFF_PROVIDERS.join(", ")}`);
  return { action: "create", to, from, reason, task, mode, dryRun };
}

function displayPath(cwd: string, path: string): string {
  const relativePath = relative(cwd, path);
  return relativePath.startsWith("..") ? path : relativePath;
}

function reviewCommand(provider: HandoffProvider): string {
  return `omb review --handoff latest --with ${provider}`;
}

function launchCommand(provider: HandoffProvider): string | undefined {
  if (provider === "gemini") return undefined;
  return `omb switch --to ${provider} --handoff latest --launch`;
}

export async function handoffCommand(args: string[], deps: HandoffCommandDependencies = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const parsed = parseHandoffArgs(args);

  if (parsed.action === "help") {
    stdout(HELP);
    return;
  }

  if (parsed.action === "list") {
    const index = readHandoffIndex(cwd);
    if (index.length === 0) {
      stdout("No handoffs found. Run `omb handoff --to <provider>` to create one.");
      return;
    }
    stdout(index.map((entry) => `${entry.created_at}  ${entry.id}  ${entry.from_provider} -> ${entry.to_provider}  ${entry.status}`).join("\n"));
    return;
  }

  if (parsed.action === "show") {
    const latest = readLatestHandoffMarkdown(cwd);
    if (!latest) throw new Error("No latest handoff found. Run `omb handoff --to <provider>` first.");
    stdout(latest);
    return;
  }

  if (!parsed.to) throw new Error(`Missing --to provider. Expected one of: ${HANDOFF_PROVIDERS.join(", ")}`);

  const result = await createHandoffArtifact({
    cwd,
    to: parsed.to,
    from: parsed.from,
    reason: parsed.reason,
    task: parsed.task,
    mode: parsed.mode,
    dryRun: parsed.dryRun,
  });

  if (parsed.dryRun) {
    stdout(result.markdown);
    return;
  }

  stdout(`Created handoff: ${displayPath(cwd, result.record.markdown_path)}`);
  stdout("Latest: .omb/handoffs/latest.md");
  stdout(`Review: ${reviewCommand(result.record.to_provider)}`);
  const launch = launchCommand(result.record.to_provider);
  if (launch) stdout(`Launch: ${launch}`);
}
