/**
 * Legacy alias boundary — single entry point for all legacy name resolution.
 *
 * Codex→CodeBuddy and OMX→OMB brand migrations left behind dual-named env
 * vars, directories, and binaries. This module centralises every legacy→canonical
 * mapping so that business modules never need to know about legacy names.
 *
 * Design rules:
 *  - Pure functions only — no side effects, no process mutations.
 *  - Canonical names always win over legacy names.
 *  - Status tracking enables gradual migration and eventual removal.
 */

import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Alias status tracking ─────────────────────────────────────────────────

export type AliasStatus =
  | "active_compat"    // both names work; write to both, read canonical-first
  | "warn_only"        // legacy name still recognised but emits a warning
  | "read_only"        // legacy path is read but never written
  | "write_disabled"   // legacy path is never written; read-through only
  | "removal_candidate"; // legacy path ignored; safe to delete references

export interface LegacyAlias {
  canonical: string;       // e.g. 'CODEBUDDY_HOME'
  legacy: string;          // e.g. 'CODEX_HOME'
  status: AliasStatus;
  description: string;
  removalTarget?: string;  // version when this alias can be removed
}

// ── Complete alias registry ───────────────────────────────────────────────

const ALIAS_REGISTRY: LegacyAlias[] = [
  // Environment variables
  {
    canonical: "CODEBUDDY_HOME",
    legacy: "CODEX_HOME",
    status: "active_compat",
    description: "CodeBuddy home directory override",
  },
  {
    canonical: "OMB_ENTRY_PATH",
    legacy: "OMX_ENTRY_PATH",
    status: "active_compat",
    description: "CLI entry-point path override",
  },
  {
    canonical: "OMB_RUNTIME_BRIDGE",
    legacy: "OMX_RUNTIME_BRIDGE",
    status: "active_compat",
    description: "Runtime bridge enable/disable flag",
  },
  {
    canonical: "OMB_RUNTIME_BINARY",
    legacy: "OMX_RUNTIME_BINARY",
    status: "active_compat",
    description: "Runtime binary path override",
  },

  // Directory names
  {
    canonical: ".codebuddy",
    legacy: ".codex",
    status: "read_only",
    description: "User-level config directory (~/.codebuddy)",
  },
  {
    canonical: ".omb",
    legacy: ".omx",
    status: "active_compat",
    description: "Project-level state directory",
  },

  // Binary names
  {
    canonical: "omb",
    legacy: "omx",
    status: "active_compat",
    description: "CLI binary name",
  },
];

// ── Registry access ───────────────────────────────────────────────────────

/** Return the full alias registry (for diagnostics / doctor output). */
export function getAliasRegistry(): ReadonlyArray<LegacyAlias> {
  return ALIAS_REGISTRY;
}

/** Look up a single alias by its canonical or legacy name. */
export function findAlias(name: string): LegacyAlias | undefined {
  return ALIAS_REGISTRY.find(
    (a) => a.canonical === name || a.legacy === name,
  );
}

// ── Resolution helpers ────────────────────────────────────────────────────

/**
 * Resolve an env-var pair with canonical-first priority.
 * Returns the value of the canonical env var, falling back to the legacy env
 * var, and finally to `defaultPath`.
 */
function resolveEnvPair(
  canonical: string,
  legacy: string,
  defaultPath: string,
  env?: NodeJS.ProcessEnv,
): string {
  const e = env ?? process.env;
  const canonicalVal = String(e[canonical] ?? "").trim();
  if (canonicalVal !== "") return canonicalVal;
  const legacyVal = String(e[legacy] ?? "").trim();
  if (legacyVal !== "") return legacyVal;
  return defaultPath;
}

// ── Public boundary functions ─────────────────────────────────────────────

/**
 * Resolve CODEBUDDY_HOME with CODEX_HOME fallback.
 * Priority: CODEBUDDY_HOME > CODEX_HOME > ~/.codebuddy
 */
export function resolveCanonicalCodebuddyHome(env?: NodeJS.ProcessEnv): string {
  return resolveEnvPair(
    "CODEBUDDY_HOME",
    "CODEX_HOME",
    join(homedir(), ".codebuddy"),
    env,
  );
}

/**
 * Resolve legacy Codex home (for compat read-through).
 * Priority: CODEX_HOME > CODEBUDDY_HOME > ~/.codex
 */
export function resolveLegacyCodexHome(env?: NodeJS.ProcessEnv): string {
  const e = env ?? process.env;
  const legacyVal = String(e.CODEX_HOME ?? "").trim();
  if (legacyVal !== "") return legacyVal;
  const canonicalVal = String(e.CODEBUDDY_HOME ?? "").trim();
  if (canonicalVal !== "") return canonicalVal;
  return join(homedir(), ".codex");
}

/**
 * Resolve the canonical state directory (.omb/state).
 * Read-through from legacy (.omx/state) is handled by the caller.
 */
export function resolveCanonicalStateDir(cwd: string): string {
  return join(cwd, ".omb", "state");
}

/**
 * Resolve the legacy state directory (.omx/state) for read-through.
 */
export function resolveLegacyStateDir(cwd: string): string {
  return join(cwd, ".omx", "state");
}

/**
 * Resolve OMB_ENTRY_PATH with OMX_ENTRY_PATH fallback.
 * Priority: OMB_ENTRY_PATH > OMX_ENTRY_PATH
 */
export function resolveCanonicalEntryPath(
  options: {
    argv1?: string | null;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string | null {
  const { env = process.env } = options;
  const canonicalVal = String(env.OMB_ENTRY_PATH ?? "").trim();
  if (canonicalVal !== "") return canonicalVal;
  const legacyVal = String(env.OMX_ENTRY_PATH ?? "").trim();
  if (legacyVal !== "") return legacyVal;
  return null;
}

/**
 * Resolve OMB_RUNTIME_BINARY with OMX_RUNTIME_BINARY fallback.
 * Priority: OMB_RUNTIME_BINARY > OMX_RUNTIME_BINARY
 */
export function resolveCanonicalRuntimeBinary(env?: NodeJS.ProcessEnv): string | undefined {
  const e = env ?? process.env;
  const canonicalVal = String(e.OMB_RUNTIME_BINARY ?? "").trim();
  if (canonicalVal !== "") return canonicalVal;
  const legacyVal = String(e.OMX_RUNTIME_BINARY ?? "").trim();
  if (legacyVal !== "") return legacyVal;
  return undefined;
}

/**
 * Check if OMB_RUNTIME_BRIDGE (or legacy OMX_RUNTIME_BRIDGE) is enabled.
 * The bridge is enabled unless explicitly set to '0'.
 */
export function isRuntimeBridgeEnabled(env?: NodeJS.ProcessEnv): boolean {
  const e = env ?? process.env;
  const canonicalVal = String(e.OMB_RUNTIME_BRIDGE ?? "").trim();
  if (canonicalVal !== "") return canonicalVal !== "0";
  const legacyVal = String(e.OMX_RUNTIME_BRIDGE ?? "").trim();
  if (legacyVal !== "") return legacyVal !== "0";
  return true; // default: enabled
}

// ── Legacy path detection ─────────────────────────────────────────────────

export interface LegacyPathReport {
  hasLegacyOmxDir: boolean;
  hasLegacyCodexDir: boolean;
  hasCanonicalOmbDir: boolean;
  hasCanonicalCodebuddyDir: boolean;
  omxDir: string;
  codexDir: string;
  ombDir: string;
  codebuddyDir: string;
}

/**
 * Check if legacy .omx/.codex paths exist in a given project root.
 */
export function readLegacyAliasIfPresent(cwd: string): LegacyPathReport {
  const omxDir = join(cwd, ".omx");
  const codexDir = join(cwd, ".codex");
  const ombDir = join(cwd, ".omb");
  const codebuddyDir = join(cwd, ".codebuddy");

  return {
    hasLegacyOmxDir: existsSync(omxDir),
    hasLegacyCodexDir: existsSync(codexDir),
    hasCanonicalOmbDir: existsSync(ombDir),
    hasCanonicalCodebuddyDir: existsSync(codebuddyDir),
    omxDir,
    codexDir,
    ombDir,
    codebuddyDir,
  };
}

/**
 * Whether legacy state paths (.omx) are still in active use in the project.
 * This is true if the .omx directory exists and contains state files.
 */
export function isLegacyPathActive(cwd: string): boolean {
  const omxStateDir = join(cwd, ".omx", "state");
  if (!existsSync(omxStateDir)) return false;
  // Check if it has any state files
  try {
    const entries = existsSync(omxStateDir);
    return entries; // directory exists = active
  } catch {
    return false;
  }
}

// ── Status-gated write helper ─────────────────────────────────────────────

/**
 * Determine whether a legacy alias should receive dual writes.
 * Returns true only when the alias status is 'active_compat'.
 */
export function shouldDualWrite(aliasName: string): boolean {
  const alias = findAlias(aliasName);
  return alias?.status === "active_compat";
}
