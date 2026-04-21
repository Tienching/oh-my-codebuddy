/**
 * Setup plan data model for oh-my-codebuddy.
 *
 * Defines the plan/preview/apply architecture:
 *   1. generateSetupPlan() inspects filesystem state and produces a
 *      deterministic list of SetupAction items.
 *   2. applySetupPlan() executes each action and records the result.
 *
 * This replaces the previous linear script approach in setup.ts.
 */

import { join } from "path";
import { existsSync, statSync, readdirSync, readFileSync } from "fs";
import {
  codebuddyHome,
  codebuddyConfigPath,
  codebuddyPromptsDir,
  codebuddyAgentsDir,
  userSkillsDir,
  ombStateDir,
  ombPlansDir,
  ombLogsDir,
  detectLegacySkillRootOverlap,
} from "../utils/paths.js";
import { getPackageRoot } from "../utils/package.js";
import { DEFAULT_FRONTIER_MODEL } from "../config/models.js";
import { COMPAT_RULES } from "./compat-rules.js";

// ---------------------------------------------------------------------------
// Re-exported types from setup.ts for backward compatibility
// ---------------------------------------------------------------------------

export {
  SETUP_SCOPES,
  type SetupScope,
  type ScopeDirectories,
  resolveScopeDirectories,
} from "../cli/setup.js";

// ---------------------------------------------------------------------------
// Action kinds and plan model
// ---------------------------------------------------------------------------

export type SetupActionKind =
  | "copy"
  | "update"
  | "remove"
  | "symlink"
  | "warn"
  | "skip"
  | "backup"
  | "verify"
  | "mkdir";

export interface SetupAction {
  kind: SetupActionKind;
  description: string;
  source?: string;
  destination: string;
  metadata?: Record<string, unknown>;
  status: "pending" | "applied" | "skipped" | "failed";
  error?: string;
}

export interface SetupPlanSummary {
  total: number;
  pending: number;
  applied: number;
  skipped: number;
  failed: number;
}

export interface SetupPlan {
  scope: import("../cli/setup.js").SetupScope;
  scopeDirectories: import("../cli/setup.js").ScopeDirectories;
  actions: SetupAction[];
  warnings: string[];
  summary: SetupPlanSummary;
}

// ---------------------------------------------------------------------------
// Plan generation options
// ---------------------------------------------------------------------------

export interface SetupPlanOptions {
  scope: import("../cli/setup.js").SetupScope;
  projectRoot: string;
  pkgRoot?: string;
  force?: boolean;
  verbose?: boolean;
  codexVersionProbe?: () => string | null;
  mcpRegistryCandidates?: string[];
}

// ---------------------------------------------------------------------------
// Plan summary computation
// ---------------------------------------------------------------------------

export function computePlanSummary(actions: SetupAction[]): SetupPlanSummary {
  let pending = 0;
  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const action of actions) {
    switch (action.status) {
      case "pending":
        pending++;
        break;
      case "applied":
        applied++;
        break;
      case "skipped":
        skipped++;
        break;
      case "failed":
        failed++;
        break;
    }
  }

  return {
    total: actions.length,
    pending,
    applied,
    skipped,
    failed,
  };
}

// ---------------------------------------------------------------------------
// Plan generation
// ---------------------------------------------------------------------------

export async function generateSetupPlan(
  options: SetupPlanOptions,
): Promise<SetupPlan> {
  const {
    scope,
    projectRoot,
    pkgRoot = getPackageRoot(),
    force = false,
  } = options;

  const { resolveScopeDirectories } = await import("../cli/setup.js");
  const scopeDirs = resolveScopeDirectories(scope, projectRoot);
  const actions: SetupAction[] = [];
  const warnings: string[] = [];

  // ── 1. Directory creation ────────────────────────────────────────────
  const dirs = [
    scopeDirs.codexHomeDir,
    scopeDirs.promptsDir,
    scopeDirs.skillsDir,
    scopeDirs.nativeAgentsDir,
    ombStateDir(projectRoot),
    ombPlansDir(projectRoot),
    ombLogsDir(projectRoot),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      actions.push({
        kind: "mkdir",
        description: `Create directory ${dir}`,
        destination: dir,
        status: "pending",
      });
    }
  }

  // ── 2. Scope persistence ─────────────────────────────────────────────
  const scopeFilePath = join(projectRoot, ".omb", "setup-scope.json");
  actions.push({
    kind: "update",
    description: `Persist setup scope "${scope}" to ${scopeFilePath}`,
    destination: scopeFilePath,
    metadata: { scope },
    status: "pending",
  });

  // ── 3. Legacy project alias ──────────────────────────────────────────
  if (scope === "project") {
    const legacyCodexDir = join(projectRoot, ".codex");
    if (
      scopeDirs.codexHomeDir !== legacyCodexDir &&
      !existsSync(legacyCodexDir)
    ) {
      actions.push({
        kind: "symlink",
        description: `Create legacy alias .codex -> ${scopeDirs.codexHomeDir}`,
        source: ".codebuddy",
        destination: legacyCodexDir,
        status: "pending",
      });
    }

    // .gitignore actions
    const gitignorePath = join(projectRoot, ".gitignore");
    const gitignoreExists = existsSync(gitignorePath);
    const gitignoreContent = gitignoreExists
      ? readFileSync(gitignorePath, "utf-8")
      : "";

    const PROJECT_GITIGNORE_ENTRIES = [
      ".omb/",
      ".codebuddy/*",
      "!.codebuddy/agents/",
      "!.codebuddy/agents/**",
      "!.codebuddy/skills/",
      "!.codebuddy/skills/**",
      ".codebuddy/skills/.system/**",
      "!.codebuddy/prompts/",
      "!.codebuddy/prompts/**",
    ];
    const LEGACY_PROJECT_GITIGNORE_ENTRIES = [".codex/", ".codebuddy/"];

    const hasEntry = (content: string, entry: string): boolean =>
      content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .some((l) => l === entry);

    const legacyEntries = new Set(LEGACY_PROJECT_GITIGNORE_ENTRIES);
    const hasLegacy = gitignoreContent
      .split(/\r?\n/)
      .some((l) => legacyEntries.has(l.trim()));

    const missingEntries = PROJECT_GITIGNORE_ENTRIES.filter(
      (entry) => !hasEntry(gitignoreContent, entry),
    );

    if (missingEntries.length > 0 || hasLegacy) {
      actions.push({
        kind: "update",
        description: `Update .gitignore with OMB project rules`,
        destination: gitignorePath,
        metadata: { missingEntries, hasLegacy },
        status: "pending",
      });
    }
  }

  // ── 4. Agent prompts ─────────────────────────────────────────────────
  const promptsSrc = join(pkgRoot, "prompts");
  const promptsDst = scopeDirs.promptsDir;
  if (existsSync(promptsSrc)) {
    const files = readdirSync(promptsSrc);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const srcPath = join(promptsSrc, file);
      if (!statSync(srcPath).isFile()) continue;

      const dstPath = join(promptsDst, file);
      const needsCopy =
        force || !existsSync(dstPath) || filesDifferSync(srcPath, dstPath);

      if (needsCopy) {
        actions.push({
          kind: "copy",
          description: `Install prompt ${file}`,
          source: srcPath,
          destination: dstPath,
          status: "pending",
        });
      } else {
        actions.push({
          kind: "skip",
          description: `Prompt ${file} already up to date`,
          destination: dstPath,
          status: "skipped",
        });
      }
    }
  }

  // ── 5. Skills ────────────────────────────────────────────────────────
  const skillsSrc = join(pkgRoot, "skills");
  const skillsDst = scopeDirs.skillsDir;
  if (existsSync(skillsSrc)) {
    const entries = readdirSync(skillsSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = join(skillsSrc, entry.name, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      const skillSrcDir = join(skillsSrc, entry.name);
      const skillDstDir = join(skillsDst, entry.name);

      // Check each file in the skill
      const skillFiles = readdirSync(skillSrcDir);
      for (const sf of skillFiles) {
        const sfPath = join(skillSrcDir, sf);
        if (!statSync(sfPath).isFile()) continue;

        const dstPath = join(skillDstDir, sf);
        const needsCopy =
          force || !existsSync(dstPath) || filesDifferSync(sfPath, dstPath);

        if (needsCopy) {
          actions.push({
            kind: "copy",
            description: `Install skill ${entry.name}/${sf}`,
            source: sfPath,
            destination: dstPath,
            status: "pending",
          });
        } else {
          actions.push({
            kind: "skip",
            description: `Skill ${entry.name}/${sf} already up to date`,
            destination: dstPath,
            status: "skipped",
          });
        }
      }
    }
  }

  // ── 6. Native agent configs ──────────────────────────────────────────
  if (existsSync(scopeDirs.nativeAgentsDir) || scope === "project") {
    const { AGENT_DEFINITIONS } = await import("../agents/definitions.js");
    for (const [name, _agent] of Object.entries(AGENT_DEFINITIONS)) {
      const promptPath = join(pkgRoot, "prompts", `${name}.md`);
      if (!existsSync(promptPath)) continue;

      const dstPath = join(scopeDirs.nativeAgentsDir, `${name}.toml`);
      const needsUpdate =
        force || !existsSync(dstPath);

      if (needsUpdate) {
        actions.push({
          kind: "update",
          description: `Install native agent config ${name}.toml`,
          destination: dstPath,
          metadata: { agentName: name },
          status: "pending",
        });
      } else {
        actions.push({
          kind: "skip",
          description: `Native agent ${name}.toml already exists`,
          destination: dstPath,
          status: "skipped",
        });
      }
    }
  }

  // ── 7. Config.toml ──────────────────────────────────────────────────
  const configPath = scopeDirs.codexConfigFile;
  actions.push({
    kind: "update",
    description: `Update config.toml`,
    destination: configPath,
    metadata: { scope },
    status: "pending",
  });

  // ── 8. Settings.json bootstrap ──────────────────────────────────────
  const settingsPath = join(scopeDirs.codexHomeDir, "settings.json");
  if (!existsSync(settingsPath)) {
    actions.push({
      kind: "update",
      description: `Bootstrap settings.json`,
      destination: settingsPath,
      metadata: { model: DEFAULT_FRONTIER_MODEL },
      status: "pending",
    });
  }

  // ── 9. Hooks.json ───────────────────────────────────────────────────
  const hooksPath = scopeDirs.codexHooksFile;
  actions.push({
    kind: "update",
    description: `Update native hooks`,
    destination: hooksPath,
    status: "pending",
  });

  // ── 10. Legacy hooks ────────────────────────────────────────────────
  if (scope === "project") {
    const legacyCodexDir = join(projectRoot, ".codex");
    const legacyHooksPath = join(legacyCodexDir, "hooks.json");
    if (
      legacyHooksPath !== hooksPath &&
      (existsSync(legacyCodexDir) || existsSync(legacyHooksPath))
    ) {
      actions.push({
        kind: "update",
        description: `Update legacy hooks at ${legacyHooksPath}`,
        destination: legacyHooksPath,
        status: "pending",
      });
    }
  }

  // ── 11. Team CLI interop verification ───────────────────────────────
  const teamCliPath = join(pkgRoot, "dist", "cli", "team.js");
  actions.push({
    kind: "verify",
    description: `Verify Team CLI API interop`,
    destination: teamCliPath,
    status: "pending",
  });

  // ── 12. AGENTS.md ──────────────────────────────────────────────────
  const agentsMdDst =
    scope === "project"
      ? join(projectRoot, "AGENTS.md")
      : join(scopeDirs.codexHomeDir, "AGENTS.md");
  const agentsMdSrc = join(pkgRoot, "templates", "AGENTS.md");

  if (existsSync(agentsMdSrc)) {
    actions.push({
      kind: "update",
      description: `Generate AGENTS.md`,
      source: agentsMdSrc,
      destination: agentsMdDst,
      status: "pending",
    });
  }

  // ── 13. Notify hook ────────────────────────────────────────────────
  const hookScript = join(pkgRoot, "dist", "scripts", "notify-hook.js");
  if (existsSync(hookScript)) {
    actions.push({
      kind: "verify",
      description: `Configure notification hook`,
      destination: hookScript,
      status: "pending",
    });
  }

  // ── 14. HUD config ────────────────────────────────────────────────
  const hudConfigPath = join(projectRoot, ".omb", "hud-config.json");
  if (force || !existsSync(hudConfigPath)) {
    actions.push({
      kind: "update",
      description: `Create HUD config`,
      destination: hudConfigPath,
      metadata: { preset: "focused" },
      status: "pending",
    });
  }

  // ── Compat rule warnings ────────────────────────────────────────────
  for (const rule of COMPAT_RULES) {
    if (rule.status === "active" && rule.condition(projectRoot)) {
      warnings.push(rule.message);
    }
  }

  // ── Legacy skill overlap warning ─────────────────────────────────────
  if (scope === "user") {
    const overlap = await detectLegacySkillRootOverlap();
    if (overlap.legacyExists && overlap.overlappingSkillNames.length > 0) {
      warnings.push(
        `Detected ${overlap.overlappingSkillNames.length} overlapping skill names between canonical ${overlap.canonicalDir} and legacy ${overlap.legacyDir}.`,
      );
    }
  }

  return {
    scope,
    scopeDirectories: scopeDirs,
    actions,
    warnings,
    summary: computePlanSummary(actions),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filesDifferSync(src: string, dst: string): boolean {
  if (!existsSync(dst)) return true;
  try {
    const srcContent = readFileSync(src, "utf-8");
    const dstContent = readFileSync(dst, "utf-8");
    return srcContent !== dstContent;
  } catch {
    return true;
  }
}
