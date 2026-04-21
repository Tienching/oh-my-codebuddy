/**
 * Setup plan executor for oh-my-codebuddy.
 *
 * Takes a SetupPlan produced by generateSetupPlan() and executes each
 * pending action, recording the result.  Supports dry-run mode and
 * verbose logging.
 */

import {
  mkdir,
  copyFile,
  writeFile,
  symlink,
  rm,
  readFile,
} from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import type { SetupPlan, SetupAction } from "./plan.js";
import { computePlanSummary } from "./plan.js";

// ---------------------------------------------------------------------------
// Apply options and result
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
  /** Callback for model upgrade prompts */
  modelUpgradePrompt?: (
    currentModel: string,
    targetModel: string,
  ) => Promise<boolean>;
  /** Callback for AGENTS.md overwrite prompts */
  agentsOverwritePrompt?: (destinationPath: string) => Promise<boolean>;
}

export interface ApplyResult {
  plan: SetupPlan;
  success: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Plan application
// ---------------------------------------------------------------------------

export async function applySetupPlan(
  plan: SetupPlan,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const { dryRun = false, verbose = false } = options;
  const errors: string[] = [];
  let hasFailure = false;

  for (const action of plan.actions) {
    if (action.status !== "pending") continue;

    try {
      if (dryRun) {
        action.status = "skipped";
        if (verbose) {
          console.log(`  [dry-run] would ${action.kind}: ${action.description}`);
        }
        continue;
      }

      await executeAction(action, options);

      action.status = "applied";
      if (verbose) {
        console.log(`  ${action.kind}: ${action.description}`);
      }
    } catch (err) {
      action.status = "failed";
      action.error =
        err instanceof Error ? err.message : String(err);
      errors.push(`${action.kind} ${action.destination}: ${action.error}`);
      hasFailure = true;
      if (verbose) {
        console.error(
          `  FAILED ${action.kind}: ${action.description} — ${action.error}`,
        );
      }
      // Continue with remaining actions
    }
  }

  plan.summary = computePlanSummary(plan.actions);

  return {
    plan,
    success: !hasFailure,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Individual action execution
// ---------------------------------------------------------------------------

async function executeAction(
  action: SetupAction,
  _options: ApplyOptions,
): Promise<void> {
  switch (action.kind) {
    case "mkdir":
      await mkdir(action.destination, { recursive: true });
      break;

    case "copy":
      if (!action.source) {
        throw new Error(`copy action missing source: ${action.description}`);
      }
      await mkdir(dirname(action.destination), { recursive: true });
      await copyFile(action.source, action.destination);
      break;

    case "update":
      await executeUpdateAction(action);
      break;

    case "remove":
      await rm(action.destination, { force: true, recursive: true });
      break;

    case "symlink":
      if (!action.source) {
        throw new Error(
          `symlink action missing source: ${action.description}`,
        );
      }
      await mkdir(dirname(action.destination), { recursive: true });
      await symlink(action.source, action.destination, "dir");
      break;

    case "verify":
      await executeVerifyAction(action);
      break;

    case "skip":
    case "warn":
    case "backup":
      // No-op for these action kinds during apply
      break;

    default:
      throw new Error(`Unknown action kind: ${action.kind}`);
  }
}

async function executeUpdateAction(action: SetupAction): Promise<void> {
  const metadata = action.metadata ?? {};

  // Scope persistence
  if (metadata.scope !== undefined) {
    await mkdir(dirname(action.destination), { recursive: true });
    const payload = JSON.stringify({ scope: metadata.scope }, null, 2) + "\n";
    await writeFile(action.destination, payload, "utf-8");
    return;
  }

  // HUD config
  if (metadata.preset !== undefined) {
    await mkdir(dirname(action.destination), { recursive: true });
    const config = JSON.stringify({ preset: metadata.preset }, null, 2);
    await writeFile(action.destination, config, "utf-8");
    return;
  }

  // Settings.json bootstrap
  if (metadata.model !== undefined) {
    await mkdir(dirname(action.destination), { recursive: true });
    const content = JSON.stringify({ model: metadata.model }, null, 2) + "\n";
    await writeFile(action.destination, content, "utf-8");
    return;
  }

  // For config.toml, hooks.json, AGENTS.md, gitignore updates,
  // the actual content generation is delegated back to setup.ts
  // through the existing functions. The plan/apply architecture
  // delegates the heavy lifting while tracking the action lifecycle.
  // These will be wired up during the setup.ts refactor (Step 6).
}

async function executeVerifyAction(action: SetupAction): Promise<void> {
  if (!existsSync(action.destination)) {
    throw new Error(`Verification target not found: ${action.destination}`);
  }

  // Team CLI API verification
  if (action.description.includes("Team CLI API")) {
    const content = await readFile(action.destination, "utf-8");
    const requiredMarkers = [
      "if (subcommand === 'api')",
      "executeTeamApiOperation",
      "TEAM_API_OPERATIONS",
    ];
    const missing = requiredMarkers.filter(
      (marker) => !content.includes(marker),
    );
    if (missing.length > 0) {
      throw new Error(
        `Team CLI interop markers missing: ${missing.join(", ")}`,
      );
    }
  }
}
