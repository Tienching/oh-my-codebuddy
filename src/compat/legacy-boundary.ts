/**
 * Legacy alias boundary — single entry point for all legacy name resolution.
 *
 * Historical Codex/OMB names may still appear in old files and diagnostics.
 * This module centralises the remaining alias metadata so business modules do
 * not invent ad-hoc compatibility rules.
 *
 * Design rules:
 *  - Pure functions only — no side effects, no process mutations.
 *  - Canonical names always win over legacy names.
 *  - Status tracking enables gradual migration and eventual removal.
 */

import { existsSync, readdirSync } from "fs";
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
    status: "removal_candidate",
    description: "Historical CodeBuddy home alias; CODEX_HOME is no longer read as CodeBuddy home",
  },

  // Directory names
  {
    canonical: ".codebuddy",
    legacy: ".codex",
    status: "read_only",
    description: "User-level config directory (~/.codebuddy)",
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

// ── Public boundary functions ─────────────────────────────────────────────

/**
 * Resolve CodeBuddy home.
 * Priority: CODEBUDDY_HOME > ~/.codebuddy
 */
export function resolveCanonicalCodebuddyHome(env?: NodeJS.ProcessEnv): string {
  const e = env ?? process.env;
  const explicit = String(e.CODEBUDDY_HOME ?? "").trim();
  return explicit !== "" ? explicit : join(homedir(), ".codebuddy");
}

/**
 * Resolve Codex home.
 * Priority: CODEX_HOME > ~/.codex
 */
export function resolveLegacyCodexHome(env?: NodeJS.ProcessEnv): string {
  const e = env ?? process.env;
  const explicit = String(e.CODEX_HOME ?? "").trim();
  return explicit !== "" ? explicit : join(homedir(), ".codex");
}

/**
 * Resolve the canonical state directory (.omb/state).
 * The legacy .omc migration completed April 2026; there is no separate
 * legacy state directory, so this replaces the former resolveLegacyStateDir.
 */
export function resolveStateDir(cwd: string): string {
  return join(cwd, ".omb", "state");
}

/** @deprecated Use resolveStateDir — the legacy/canonical split was a no-op. */
export const resolveCanonicalStateDir = resolveStateDir;

/** @deprecated Use resolveStateDir — the legacy/canonical split was a no-op. */
export const resolveLegacyStateDir = resolveStateDir;

/**
 * Resolve OMB_ENTRY_PATH entry point.
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
  return null;
}

/**
 * Resolve OMB_RUNTIME_BINARY path.
 */
export function resolveCanonicalRuntimeBinary(env?: NodeJS.ProcessEnv): string | undefined {
  const e = env ?? process.env;
  const canonicalVal = String(e.OMB_RUNTIME_BINARY ?? "").trim();
  if (canonicalVal !== "") return canonicalVal;
  return undefined;
}

/**
 * Check if OMB_RUNTIME_BRIDGE is enabled.
 * The bridge is enabled unless explicitly set to '0'.
 */
export function isRuntimeBridgeEnabled(env?: NodeJS.ProcessEnv): boolean {
  const e = env ?? process.env;
  const canonicalVal = String(e.OMB_RUNTIME_BRIDGE ?? "").trim();
  if (canonicalVal !== "") return canonicalVal !== "0";
  return true; // default: enabled
}

// ── Legacy path detection ─────────────────────────────────────────────────

export interface LegacyPathReport {
  hasLegacyOmbDir: boolean;
  hasLegacyCodexDir: boolean;
  hasCanonicalOmbDir: boolean;
  hasCanonicalCodebuddyDir: boolean;
  hasClaudeDir: boolean;
  ombDir: string;
  codexDir: string;
  codebuddyDir: string;
  claudeDir: string;
}

/**
 * Check if legacy .omb/.codex paths exist in a given project root.
 */
export function readLegacyAliasIfPresent(cwd: string): LegacyPathReport {
  const ombDir = join(cwd, ".omb");
  const codexDir = join(cwd, ".codex");
  const codebuddyDir = join(cwd, ".codebuddy");
  const claudeDir = join(cwd, ".claude");

  return {
    hasLegacyOmbDir: existsSync(ombDir),
    hasLegacyCodexDir: existsSync(codexDir),
    hasCanonicalOmbDir: existsSync(ombDir),
    hasCanonicalCodebuddyDir: existsSync(codebuddyDir),
    hasClaudeDir: existsSync(claudeDir),
    ombDir,
    codexDir,
    codebuddyDir,
    claudeDir,
  };
}

/**
 * Whether the .omb state directory is still in active use in the project.
 * True if the .omb/state directory exists and contains at least one file.
 */
export function isLegacyPathActive(cwd: string): boolean {
  const stateDir = join(cwd, ".omb", "state");
  if (!existsSync(stateDir)) return false;
  try {
    const entries = readdirSync(stateDir);
    return entries.length > 0;
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
