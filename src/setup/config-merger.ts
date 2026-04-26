/**
 * Config/settings.json merger for oh-my-codebuddy.
 *
 * Extracts the settings.json bootstrap, model field handling, and TUI
 * ownership rules from the monolithic setup.ts into a pure data-driven
 * merge function.
 */

import { getRootModelName } from "../config/generator.js";

// ---------------------------------------------------------------------------
// Input and result types
// ---------------------------------------------------------------------------

export interface ConfigMergeInput {
  existingConfig: Record<string, unknown> | null;
  desiredState: Record<string, unknown>;
  ownershipPolicy: "managed" | "preserved";
  tuiOwnership?: "managed" | "preserved";
}

export interface ConfigMergeResult {
  merged: Record<string, unknown>;
  diagnostics: string[];
  changedFields: string[];
  ownedFields: string[];
}

// ---------------------------------------------------------------------------
// Owned fields (fields that OMB manages in settings.json)
// ---------------------------------------------------------------------------

const OMB_OWNED_FIELDS = new Set(["model"]);

// ---------------------------------------------------------------------------
// Merge function
// ---------------------------------------------------------------------------

export function mergeConfig(input: ConfigMergeInput): ConfigMergeResult {
  const {
    existingConfig,
    desiredState,
    ownershipPolicy,
    tuiOwnership = ownershipPolicy,
  } = input;

  const diagnostics: string[] = [];
  const changedFields: string[] = [];
  const ownedFields: string[] = [];

  // Start from existing or empty
  const merged: Record<string, unknown> = existingConfig
    ? { ...existingConfig }
    : {};

  // Apply desired state for owned fields
  for (const [key, value] of Object.entries(desiredState)) {
    const isOwned = OMB_OWNED_FIELDS.has(key);
    if (isOwned) {
      ownedFields.push(key);
    }

    if (ownershipPolicy === "managed" || isOwned) {
      const existingValue = merged[key];
      if (existingValue !== value) {
        if (existingValue !== undefined && !isOwned) {
          diagnostics.push(
            `Overwriting non-owned field "${key}" (was: ${JSON.stringify(existingValue)})`,
          );
        }
        merged[key] = value;
        changedFields.push(key);
      }
    } else {
      // Preserved: skip non-owned fields
      if (merged[key] === undefined && value !== undefined) {
        diagnostics.push(
          `Preserved policy: not setting non-owned field "${key}"`,
        );
      }
    }
  }

  // TUI ownership diagnostic
  if (tuiOwnership === "preserved") {
    diagnostics.push(
      "CodeBuddy/Codex CLI >= 0.107.0 manages [tui]; OMB left that section untouched.",
    );
  }

  return {
    merged,
    diagnostics,
    changedFields,
    ownedFields,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine if OMB should manage the TUI section based on the installed
 * CodeBuddy/Codex CLI version.
 */
export function shouldOmbManageTui(
  codexVersionOutput: string | null,
): boolean {
  if (!codexVersionOutput) return true;
  const TUI_OWNED_BY_CODEX_VERSION = [0, 107, 0] as const;
  const parsed = parseSemverTriplet(codexVersionOutput);
  if (!parsed) return true;
  return !semverGte(parsed, TUI_OWNED_BY_CODEX_VERSION);
}

function parseSemverTriplet(
  version: string,
): [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function semverGte(
  version: [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  if (version[0] !== minimum[0]) return version[0] > minimum[0];
  if (version[1] !== minimum[1]) return version[1] > minimum[1];
  return version[2] >= minimum[2];
}

/**
 * Build the desired settings.json state from config.toml content.
 */
export function buildDesiredSettingsState(
  resolvedConfigToml: string,
): Record<string, unknown> {
  const model = getRootModelName(resolvedConfigToml);
  return model ? { model } : {};
}

/**
 * Build bootstrap settings.json content string.
 */
export function buildBootstrapSettingsJson(
  resolvedConfigToml: string,
): string {
  const state = buildDesiredSettingsState(resolvedConfigToml);
  return JSON.stringify(state, null, 2) + "\n";
}
