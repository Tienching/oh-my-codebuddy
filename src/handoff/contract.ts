export const HANDOFF_PROVIDERS = ["codebuddy", "codex", "claude", "gemini"] as const;
export type HandoffProvider = (typeof HANDOFF_PROVIDERS)[number];

export const HANDOFF_STATUSES = ["created", "reviewed", "launched", "completed", "abandoned"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export interface HandoffRequest {
  to: HandoffProvider;
  from?: HandoffProvider;
  reason?: string;
  task?: string;
  cwd: string;
  mode?: "solo" | "ralph" | "team" | "autopilot" | "unknown";
  dryRun?: boolean;
  includeDiff?: "none" | "summary" | "full";
}

export interface HandoffArtifactRecord {
  id: string;
  from_provider: HandoffProvider | "unknown";
  to_provider: HandoffProvider;
  cwd: string;
  mode: HandoffRequest["mode"];
  reason?: string;
  task?: string;
  markdown_path: string;
  json_path: string;
  created_at: string;
  status: HandoffStatus;
}

export function isHandoffProvider(value: string): value is HandoffProvider {
  return (HANDOFF_PROVIDERS as readonly string[]).includes(value);
}

export function parseHandoffProvider(value: string, flagName = "provider"): HandoffProvider {
  const normalized = value.trim().toLowerCase();
  if (isHandoffProvider(normalized)) return normalized;
  throw new Error(`Invalid ${flagName} provider "${value}". Expected one of: ${HANDOFF_PROVIDERS.join(", ")}`);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatUtcTimestamp(now: Date): string {
  return [
    now.getUTCFullYear(),
    pad2(now.getUTCMonth() + 1),
    pad2(now.getUTCDate()),
    "-",
    pad2(now.getUTCHours()),
    pad2(now.getUTCMinutes()),
    pad2(now.getUTCSeconds()),
  ].join("");
}

export function buildHandoffId(now = new Date()): string {
  const suffix = Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(2, 8).padEnd(6, "0");
  return `handoff-${formatUtcTimestamp(now)}-${suffix}`;
}
