import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export interface UnifiedMcpRegistryServer {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  startupTimeoutSec?: number;
}

export interface UnifiedMcpRegistryLoadResult {
  servers: UnifiedMcpRegistryServer[];
  sourcePath?: string;
  warnings: string[];
}

export interface ClaudeCodeMcpServerConfig {
  command: string;
  args: string[];
  enabled: boolean;
}

export interface ClaudeCodeSettingsSyncPlan {
  content?: string;
  added: string[];
  unchanged: string[];
  warnings: string[];
}
interface LoadUnifiedMcpRegistryOptions {
  candidates?: string[];
  homeDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toClaudeCodeMcpServerConfig(
  server: UnifiedMcpRegistryServer,
): ClaudeCodeMcpServerConfig {
  return {
    command: server.command,
    args: [...server.args],
    enabled: server.enabled,
  };
}
function normalizeTimeout(
  value: unknown,
  name: string,
  warnings: string[],
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    warnings.push(`registry entry "${name}" has invalid timeout; ignoring timeout`);
    return undefined;
  }
  return Math.floor(value);
}

function normalizeEntry(
  name: string,
  value: unknown,
  warnings: string[],
): UnifiedMcpRegistryServer | null {
  if (!isRecord(value)) {
    warnings.push(`registry entry "${name}" is not an object; skipping`);
    return null;
  }

  const command = value.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    warnings.push(`registry entry "${name}" is missing command; skipping`);
    return null;
  }

  const argsValue = value.args;
  if (
    argsValue !== undefined &&
    (!Array.isArray(argsValue) || argsValue.some((item) => typeof item !== "string"))
  ) {
    warnings.push(`registry entry "${name}" has non-string args; skipping`);
    return null;
  }

  const enabledValue = value.enabled;
  if (enabledValue !== undefined && typeof enabledValue !== "boolean") {
    warnings.push(`registry entry "${name}" has non-boolean enabled; skipping`);
    return null;
  }

  const timeoutCandidate =
    value.timeout ?? value.startup_timeout_sec ?? value.startupTimeoutSec;

  return {
    name,
    command,
    args: (argsValue as string[] | undefined) ?? [],
    enabled: enabledValue ?? true,
    startupTimeoutSec: normalizeTimeout(timeoutCandidate, name, warnings),
  };
}

export function getUnifiedMcpRegistryCandidates(homeDir = homedir()): string[] {
  return [join(homeDir, ".omb", "mcp-registry.json")];
}

export function getLegacyUnifiedMcpRegistryCandidate(homeDir = homedir()): string {
  return join(homeDir, ".omc", "mcp-registry.json");
}

export async function loadUnifiedMcpRegistry(
  options: LoadUnifiedMcpRegistryOptions = {},
): Promise<UnifiedMcpRegistryLoadResult> {
  const candidates =
    options.candidates ?? getUnifiedMcpRegistryCandidates(options.homeDir);
  const sourcePath = candidates.find((candidate) => existsSync(candidate));
  if (!sourcePath) {
    return { servers: [], warnings: [] };
  }

  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(sourcePath, "utf-8"));
  } catch (error) {
    warnings.push(`failed to parse shared MCP registry at ${sourcePath}: ${String(error)}`);
    return { servers: [], sourcePath, warnings };
  }

  if (!isRecord(parsed)) {
    warnings.push(`shared MCP registry at ${sourcePath} must be a JSON object`);
    return { servers: [], sourcePath, warnings };
  }

  const servers: UnifiedMcpRegistryServer[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    const normalized = normalizeEntry(name, value, warnings);
    if (!normalized) continue;
    servers.push(normalized);
  }

  return { servers, sourcePath, warnings };
}

export function planClaudeCodeMcpSettingsSync(
  existingContent: string,
  servers: UnifiedMcpRegistryServer[],
): ClaudeCodeSettingsSyncPlan {
  if (servers.length === 0) {
    return { added: [], unchanged: [], warnings: [] };
  }

  let parsed: unknown = {};
  const trimmed = existingContent.trim();
  if (trimmed.length > 0) {
    try {
      parsed = JSON.parse(existingContent);
    } catch (error) {
      return {
        added: [],
        unchanged: [],
        warnings: [`failed to parse Claude settings.json: ${String(error)}`],
      };
    }
  }

  if (!isRecord(parsed)) {
    return {
      added: [],
      unchanged: [],
      warnings: ["Claude settings.json must contain a JSON object"],
    };
  }

  const currentMcpServers = parsed.mcpServers;
  if (currentMcpServers !== undefined && !isRecord(currentMcpServers)) {
    return {
      added: [],
      unchanged: [],
      warnings: ['Claude settings.json field "mcpServers" must be an object'],
    };
  }

  const nextMcpServers: Record<string, unknown> = {
    ...(currentMcpServers ?? {}),
  };
  const added: string[] = [];
  const unchanged: string[] = [];

  for (const server of servers) {
    if (Object.hasOwn(nextMcpServers, server.name)) {
      unchanged.push(server.name);
      continue;
    }
    nextMcpServers[server.name] = toClaudeCodeMcpServerConfig(server);
    added.push(server.name);
  }

  if (added.length === 0) {
    return { added, unchanged, warnings: [] };
  }

  return {
    content: `${JSON.stringify(
      {
        ...parsed,
        mcpServers: nextMcpServers,
      },
      null,
      2,
    )}\n`,
    added,
    unchanged,
    warnings: [],
  };
}

/**
 * The 4 OMB-built-in MCP servers. These are the canonical source of truth
 * for what OMB ships out of the box; keep in sync with
 * `src/config/generator.ts#getOmbTablesBlock` (the codex/TOML equivalent).
 */
export const OMB_BUILTIN_MCP_NAMES = [
  "omb_state",
  "omb_memory",
  "omb_code_intel",
  "omb_trace",
] as const;

type OmbBuiltinMcpName = (typeof OMB_BUILTIN_MCP_NAMES)[number];

interface OmbBuiltinMcpSpec {
  name: OmbBuiltinMcpName;
  serverScript: string; // e.g. "state-server.js"
  startupTimeoutSec: number;
}

const OMB_BUILTIN_MCP_SPECS: readonly OmbBuiltinMcpSpec[] = [
  { name: "omb_state", serverScript: "state-server.js", startupTimeoutSec: 5 },
  { name: "omb_memory", serverScript: "memory-server.js", startupTimeoutSec: 5 },
  {
    name: "omb_code_intel",
    serverScript: "code-intel-server.js",
    startupTimeoutSec: 10,
  },
  { name: "omb_trace", serverScript: "trace-server.js", startupTimeoutSec: 5 },
];

export function buildOmbBuiltinMcpServers(
  pkgRoot: string,
): UnifiedMcpRegistryServer[] {
  return OMB_BUILTIN_MCP_SPECS.map((spec) => ({
    name: spec.name,
    command: "node",
    args: [join(pkgRoot, "dist", "mcp", spec.serverScript)],
    enabled: true,
    startupTimeoutSec: spec.startupTimeoutSec,
  }));
}

export function isOmbBuiltinMcpName(name: string): boolean {
  return (OMB_BUILTIN_MCP_NAMES as readonly string[]).includes(name);
}

export function isOmbMcpServerName(name: string): boolean {
  return name.startsWith("omb-") || name.startsWith("omb_");
}

export interface ClaudeOmbMcpConfigFilePlan {
  /** Full file content for `omb-mcp.json`, already newline-terminated. */
  content: string;
  /** Server names the file will declare (for summary output). */
  names: string[];
  /** Non-fatal warnings (e.g. shared-registry parse issues). */
  warnings: string[];
}

/**
 * Plan the contents of `<claude-home>/omb-mcp.json`: a standalone
 * `.mcp.json`-shaped file that lists OMB's built-in MCP servers plus any
 * OMB-prefixed entries from the shared MCP registry
 * (`~/.omb/mcp-registry.json`).
 *
 * Intentionally decoupled from any on-disk `settings.json` or `.claude.json`:
 * see M1 rationale (commit 26b4c67d) -- Claude CLI silently ignores
 * `settings.json#mcpServers`, and `.claude.json` also stores auth state so
 * OMB should not merge there. This file is OMB-owned and OMB-only; users
 * activate it via `claude --mcp-config <path>` or by merging its
 * `mcpServers` block into their own `.mcp.json` / `.claude.json`.
 *
 * `sharedRegistryServers` should be `sharedMcpRegistry.servers` from
 * `loadUnifiedMcpRegistry(...)`. Non-OMB-prefixed entries are intentionally
 * skipped: they belong to whatever registry the user maintains for their
 * own tools, not to OMB's managed surface.
 */
export function planClaudeOmbMcpConfigFile(
  pkgRoot: string,
  sharedRegistryServers: readonly UnifiedMcpRegistryServer[],
): ClaudeOmbMcpConfigFilePlan {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const servers: UnifiedMcpRegistryServer[] = [];

  for (const builtin of buildOmbBuiltinMcpServers(pkgRoot)) {
    servers.push(builtin);
    seen.add(builtin.name);
  }
  for (const shared of sharedRegistryServers) {
    if (!isOmbMcpServerName(shared.name)) continue;
    if (seen.has(shared.name)) {
      // Shared registry entry with the same name as a built-in. Prefer the
      // registry version (user intent wins) but flag it so users know
      // something overrode the default.
      const index = servers.findIndex((s) => s.name === shared.name);
      if (index >= 0) servers[index] = shared;
      warnings.push(
        `omb-mcp.json: shared MCP registry entry "${shared.name}" overrides the built-in server; remove the registry entry if this was unintentional`,
      );
      continue;
    }
    servers.push(shared);
    seen.add(shared.name);
  }

  const mcpServers: Record<string, ClaudeCodeMcpServerConfig> = {};
  for (const server of servers) {
    mcpServers[server.name] = toClaudeCodeMcpServerConfig(server);
  }

  return {
    content: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
    names: servers.map((s) => s.name),
    warnings,
  };
}
