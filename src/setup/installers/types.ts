/**
 * Asset installer interface for oh-my-codebuddy setup.
 *
 * Each installer handles a specific asset type (prompts, skills, native
 * agents, AGENTS.md, hooks) and produces a list of SetupAction items
 * that the plan generator can include.
 */

import type { SetupAction } from "../plan.js";

// ---------------------------------------------------------------------------
// Installer options
// ---------------------------------------------------------------------------

export interface InstallerOptions {
  scope: import("../../cli/setup.js").SetupScope;
  projectRoot: string;
  pkgRoot: string;
  force?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Installer interface
// ---------------------------------------------------------------------------

export interface AssetInstaller {
  name: string;
  generateActions(options: InstallerOptions): Promise<SetupAction[]>;
  applyAction(action: SetupAction): Promise<void>;
}
