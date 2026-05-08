import { parseHandoffProvider } from "../handoff/contract.js";
import { renderHandoffReview, resolveHandoffArtifactRef, reviewHandoff } from "../review/handoff-review.js";
import { formatCliText } from "./brand.js";

const HELP = formatCliText([
  "Usage: {cmd} review [--handoff <latest|id|path>] [--with <provider>] [--json]",
  "",
  "Review a provider handoff artifact for switch/readiness shape.",
  "",
  "Options:",
  "  --handoff <ref>   Handoff ref: latest (default), handoff id, or JSON path",
  "  --with <provider> Validate reviewer provider name for cross-provider workflows",
  "  --json            Emit machine-readable review result",
  "  --help, -h        Show this help",
].join("\n"));

export interface ReviewCommandDependencies {
  cwd?: string;
  stdout?: (line: string) => void;
}

interface ParsedReviewArgs {
  help: boolean;
  json: boolean;
  handoffRef: string;
  withProvider?: string;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value after ${flag}`);
  return value;
}

export function parseReviewArgs(args: string[]): ParsedReviewArgs {
  let help = false;
  let json = false;
  let handoffRef = "latest";
  let withProvider: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h" || arg === "help") { help = true; continue; }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--handoff") { handoffRef = readValue(args, i, arg); i += 1; continue; }
    if (arg.startsWith("--handoff=")) { handoffRef = arg.slice("--handoff=".length); continue; }
    if (arg === "--with") { withProvider = parseHandoffProvider(readValue(args, i, arg), "--with"); i += 1; continue; }
    if (arg.startsWith("--with=")) { withProvider = parseHandoffProvider(arg.slice("--with=".length), "--with"); continue; }
    throw new Error(`Unknown review argument: ${arg}`);
  }
  return { help, json, handoffRef, withProvider };
}

export async function reviewCommand(args: string[], deps: ReviewCommandDependencies = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const parsed = parseReviewArgs(args);
  if (parsed.help) {
    stdout(HELP);
    return;
  }
  const artifact = resolveHandoffArtifactRef(cwd, parsed.handoffRef);
  const result = reviewHandoff(artifact);
  const payload = { ...result, reviewer_provider: parsed.withProvider };
  stdout(parsed.json ? JSON.stringify(payload, null, 2) : renderHandoffReview(result));
}
