/**
 * Compat/legacy migration rules for oh-my-codebuddy setup.
 *
 * Converts LEGACY_SCOPE_MIGRATION and LEGACY_SETUP_MODEL from scattered
 * constants into data-driven rules.  Each rule describes a migration path
 * from a legacy value/path to the current canonical form.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { DEFAULT_FRONTIER_MODEL } from "../config/models.js";
import { codebuddyConfigPath } from "../utils/paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompatRuleStatus = "active" | "deprecated" | "removal_candidate";

export interface CompatRule {
  id: string;
  from: string;
  to: string;
  message: string;
  autoFix: boolean;
  status: CompatRuleStatus;
  condition: (projectRoot: string) => boolean;
}

// ---------------------------------------------------------------------------
// Legacy constants (now data-driven)
// ---------------------------------------------------------------------------

/** Legacy scope values that may appear in persisted setup-scope.json files. */
const LEGACY_SCOPE_MIGRATION: Record<string, "project"> = {
  "project-local": "project",
};

/** Legacy model that should be upgraded. */
const LEGACY_SETUP_MODEL = "gpt-5.3-codex";

// ---------------------------------------------------------------------------
// Compat rules
// ---------------------------------------------------------------------------

/**
 * All active compat/migration rules.
 *
 * Consumers should iterate this array to detect and report legacy state.
 */
export const COMPAT_RULES: CompatRule[] = [
  // ── Legacy .codex directory ─────────────────────────────────────────
  {
    id: "legacy-codex-dir",
    from: ".codex",
    to: ".codebuddy",
    message:
      "Historical .codex directory detected. CodeBuddy setup no longer migrates it; use --provider codex when you want Codex-owned files.",
    autoFix: false,
    status: "removal_candidate",
    condition: (cwd: string): boolean => {
      return existsSync(join(cwd, ".codex"));
    },
  },

  // ── Legacy .omb state directory ─────────────────────────────────────
  {
    id: "legacy-omb-state",
    from: ".omb",
    to: ".omb",
    message:
      "Legacy .omb state directory detected. OMB reads both .omb and .omb for backward compatibility.",
    autoFix: false,
    status: "deprecated",
    condition: (cwd: string): boolean => {
      return existsSync(join(cwd, ".omb"));
    },
  },

  // ── Legacy model upgrade ────────────────────────────────────────────
  {
    id: "model-legacy-upgrade",
    from: LEGACY_SETUP_MODEL,
    to: DEFAULT_FRONTIER_MODEL,
    message: `Legacy model "${LEGACY_SETUP_MODEL}" detected. Consider upgrading to "${DEFAULT_FRONTIER_MODEL}".`,
    autoFix: false, // Requires user confirmation
    status: "active",
    condition: (): boolean => {
      const configPath = codebuddyConfigPath();
      if (!existsSync(configPath)) return false;
      try {
        const content = readFileSync(configPath, "utf-8");
        return content.includes(LEGACY_SETUP_MODEL);
      } catch {
        return false;
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Exported helpers (backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Look up a compat rule by its id.
 */
export function getCompatRule(id: string): CompatRule | undefined {
  return COMPAT_RULES.find((rule) => rule.id === id);
}

/**
 * Get the legacy scope migration mapping.
 * Exported for backward compatibility with setup.ts internals.
 */
export function getLegacyScopeMigration(): Record<string, "project"> {
  return { ...LEGACY_SCOPE_MIGRATION };
}

/**
 * Get the legacy setup model constant.
 * Exported for backward compatibility with setup.ts internals.
 */
export function getLegacySetupModel(): string {
  return LEGACY_SETUP_MODEL;
}
