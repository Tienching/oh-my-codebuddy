/**
 * Setup plan data model for oh-my-codebuddy.
 *
 * Defines the plan/preview/apply architecture:
 *   1. generateSetupPlan() inspects filesystem state and produces a
 *      deterministic list of SetupAction items.
 *   2. applySetupPlan() executes each action and records the result.
 *
 * This replaces the previous linear script approach in setup.ts.
 *
 * ⚠️  Provider apply coverage (status as of 2026-04-27):
 *   generateSetupPlan() is provider-aware for all action kinds, but
 *   applySetupPlan() only fully executes the action kinds whose content
 *   generation is already implemented inside `executeAction`/`executeUpdateAction`
 *   (mkdir, copy, remove, symlink, verify, scope persistence, HUD preset,
 *   settings.json bootstrap). Other update kinds (config.toml, hooks.json,
 *   AGENTS.md, gitignore) are intentionally delegated back to the legacy
 *   `src/cli/setup.ts` pipeline, which does the real writes. The plan/apply
 *   flow therefore remains **preview-oriented** for those kinds: running
 *   applySetupPlan() alone will not produce a fully installed provider
 *   tree. Real installs still go through `omb setup`. Treat plan.ts as the
 *   source of truth for "what would change" and the legacy setup CLI as the
 *   source of truth for "what actually gets written" until the apply path
 *   wires up content generation for the remaining kinds.
 */

import { join } from "path";
import { existsSync, statSync, readdirSync, readFileSync } from "fs";
import {
  ombStateDir,
  ombPlansDir,
  ombLogsDir,
  detectLegacySkillRootOverlap,
} from "../utils/paths.js";
import { getPackageRoot } from "../utils/package.js";
import { DEFAULT_FRONTIER_MODEL } from "../config/models.js";
import { COMPAT_RULES } from "./compat-rules.js";
import type { SetupProvider } from "../cli/setup.js";

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
  provider: SetupProvider;
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
  provider?: SetupProvider;
  force?: boolean;
  verbose?: boolean;
  codexVersionProbe?: () => string | null;
  mcpRegistryCandidates?: string[];
}

type SetupTargetProvider = Exclude<SetupProvider, "both" | "all">;

const PROJECT_GITIGNORE_BASE_ENTRIES = [
  ".omb/",
] as const;
const PROJECT_CODEBUDDY_GITIGNORE_ENTRIES = [
  ".codebuddy/*",
  "!.codebuddy/agents/",
  "!.codebuddy/agents/**",
  "!.codebuddy/skills/",
  "!.codebuddy/skills/**",
  ".codebuddy/skills/.system/**",
  "!.codebuddy/prompts/",
  "!.codebuddy/prompts/**",
] as const;
const PROJECT_CODEX_GITIGNORE_ENTRIES = [
  ".codex/*",
  "!.codex/agents/",
  "!.codex/agents/**",
  "!.codex/skills/",
  "!.codex/skills/**",
  ".codex/skills/.system/**",
  "!.codex/prompts/",
  "!.codex/prompts/**",
] as const;
const PROJECT_CLAUDE_GITIGNORE_ENTRIES = [
  ".claude/*",
  "!.claude/agents/",
  "!.claude/agents/**",
  "!.claude/skills/",
  "!.claude/skills/**",
  ".claude/skills/.system/**",
  "!.claude/prompts/",
  "!.claude/prompts/**",
] as const;

const LEGACY_PROJECT_GITIGNORE_ENTRIES = [".codex/", ".codebuddy/", ".claude/"] as const;

function setupProviderTargets(provider: SetupProvider): SetupTargetProvider[] {
  switch (provider) {
    case "both":
      return ["codebuddy", "codex"];
    case "all":
      return ["codebuddy", "codex", "claude"];
    case "codebuddy":
    case "codex":
    case "claude":
      return [provider];
  }
}

function providerDisplayName(provider: SetupTargetProvider): string {
  switch (provider) {
    case "codebuddy":
      return "CodeBuddy";
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
  }
}

function projectGitignoreEntriesForProvider(
  provider: SetupProvider,
): readonly string[] {
  return [
    ...PROJECT_GITIGNORE_BASE_ENTRIES,
    ...(provider === "codex" || provider === "claude" ? [] : PROJECT_CODEBUDDY_GITIGNORE_ENTRIES),
    ...(provider === "codebuddy" || provider === "claude" ? [] : PROJECT_CODEX_GITIGNORE_ENTRIES),
    ...(provider === "codebuddy" || provider === "codex" || provider === "both" ? [] : PROJECT_CLAUDE_GITIGNORE_ENTRIES),
  ];
}

function planLegacySkillOverlapMessage(
  overlap: Awaited<ReturnType<typeof detectLegacySkillRootOverlap>>,
  provider: SetupTargetProvider,
): string {
  const providerName = providerDisplayName(provider);

  if (overlap.overlappingSkillNames.length === 0) {
    return (
      `Legacy ~/.agents/skills still exists (${overlap.legacySkillCount} skills) ` +
      `alongside canonical ${overlap.canonicalDir}. ${providerName} may still discover both roots; ` +
      `archive or remove ~/.agents/skills if ${providerName} shows duplicate entries.`
    );
  }

  const mismatchSuffix = overlap.mismatchedSkillNames.length > 0
    ? ` ${overlap.mismatchedSkillNames.length} overlap with different SKILL.md content.`
    : "";

  return (
    `${overlap.overlappingSkillNames.length} overlapping skill names between ${overlap.canonicalDir} and ` +
    `${overlap.legacyDir}. ${providerName} may show duplicate skills${mismatchSuffix}`
  );
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
    provider = "codebuddy",
  } = options;

  const { resolveScopeDirectories } = await import("../cli/setup.js");
  const setupTargets = setupProviderTargets(provider).map((targetProvider) => ({
    provider: targetProvider,
    scopeDirs: resolveScopeDirectories(scope, projectRoot, targetProvider),
  }));
  const scopeDirs = setupTargets[0]!.scopeDirs;
  const actions: SetupAction[] = [];
  const warnings: string[] = [];

  // ── 1. Directory creation ────────────────────────────────────────────
  for (const target of setupTargets) {
    const dirs = [
      target.scopeDirs.codexHomeDir,
      target.scopeDirs.promptsDir,
      target.scopeDirs.skillsDir,
      target.scopeDirs.nativeAgentsDir,
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
  }

  for (const dir of [
    ombStateDir(projectRoot),
    ombPlansDir(projectRoot),
    ombLogsDir(projectRoot),
  ]) {
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
    metadata: { scope, provider },
    status: "pending",
  });

  // ── 3. Project-local ignores ────────────────────────────────────────
  if (scope === "project") {
    const gitignorePath = join(projectRoot, ".gitignore");
    const gitignoreExists = existsSync(gitignorePath);
    const gitignoreContent = gitignoreExists
      ? readFileSync(gitignorePath, "utf-8")
      : "";

    const projectGitignoreEntries = [
      ...projectGitignoreEntriesForProvider(provider),
    ];

    const hasEntry = (content: string, entry: string): boolean =>
      content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .some((l) => l === entry);

  const legacyEntries = new Set<string>(LEGACY_PROJECT_GITIGNORE_ENTRIES);
    const hasLegacy = gitignoreContent
      .split(/\r?\n/)
      .some((l) => legacyEntries.has(l.trim()));

    const missingEntries = projectGitignoreEntries.filter(
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
  const skillsSrc = join(pkgRoot, "skills");

  if (existsSync(promptsSrc)) {
    const files = readdirSync(promptsSrc);
    for (const target of setupTargets) {
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const srcPath = join(promptsSrc, file);
        if (!statSync(srcPath).isFile()) continue;

        const dstPath = join(target.scopeDirs.promptsDir, file);
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
  }

  // ── 5. Skills ────────────────────────────────────────────────────────
  if (existsSync(skillsSrc)) {
    const entries = readdirSync(skillsSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = join(skillsSrc, entry.name, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      const skillSrcDir = join(skillsSrc, entry.name);

      // Check each file in the skill
      const skillFiles = readdirSync(skillSrcDir);
      for (const target of setupTargets) {
        const skillDstDir = join(target.scopeDirs.skillsDir, entry.name);
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
  }

  // ── 6. Native agent configs ──────────────────────────────────────────
  const agentDefs = await import("../agents/definitions.js");
  const { AGENT_DEFINITIONS } = agentDefs;
  for (const target of setupTargets) {
    if (existsSync(target.scopeDirs.nativeAgentsDir) || scope === "project") {
      for (const [name] of Object.entries(AGENT_DEFINITIONS)) {
        const promptPath = join(pkgRoot, "prompts", `${name}.md`);
        if (!existsSync(promptPath)) continue;

        const dstPath = join(target.scopeDirs.nativeAgentsDir, `${name}.toml`);
        const needsUpdate =
          force || !existsSync(dstPath);

        if (needsUpdate) {
          actions.push({
            kind: "update",
            description: `Install native agent config ${name}.toml`,
            destination: dstPath,
            metadata: { agentName: name, provider: target.provider },
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
  }

  // ── 7. Config.toml ──────────────────────────────────────────────────
  for (const target of setupTargets) {
    actions.push({
      kind: "update",
      description: `Update config.toml`,
      destination: target.scopeDirs.codexConfigFile,
      metadata: { scope, provider: target.provider },
      status: "pending",
    });
  }

  // ── 8. Settings.json bootstrap ──────────────────────────────────────
  for (const target of setupTargets) {
    const settingsPath = join(target.scopeDirs.codexHomeDir, "settings.json");
    if (!existsSync(settingsPath)) {
      actions.push({
        kind: "update",
        description: `Bootstrap settings.json`,
        destination: settingsPath,
        metadata: {
          model: DEFAULT_FRONTIER_MODEL,
          provider: target.provider,
        },
        status: "pending",
      });
    }
  }

  // ── 9. Hooks.json ───────────────────────────────────────────────────
  for (const target of setupTargets) {
    actions.push({
      kind: "update",
      description: `Update native hooks`,
      destination: target.scopeDirs.codexHooksFile,
      metadata: { provider: target.provider },
      status: "pending",
    });
  }

  // ── 10. Legacy hooks ────────────────────────────────────────────────
  if (scope === "project") {
    if (provider === "codebuddy" && existsSync(join(projectRoot, ".codex"))) {
      const legacyHooksPath = join(projectRoot, ".codex", "hooks.json");
      actions.push({
        kind: "update",
        description: `Update legacy hooks at ${legacyHooksPath}`,
        destination: legacyHooksPath,
        metadata: { provider: "codebuddy", legacyTarget: ".codex/hooks.json" },
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
  const agentsMdSrc = join(pkgRoot, "templates", "AGENTS.md");

  if (existsSync(agentsMdSrc)) {
    const agentTargets =
      scope === "project"
        ? [{
            destination: join(projectRoot, "AGENTS.md"),
            provider: provider,
          }]
        : setupTargets.map((target) => ({
            destination: join(target.scopeDirs.codexHomeDir, "AGENTS.md"),
            provider: target.provider,
          }));

    for (const agentTarget of agentTargets) {
      const alreadyQueued = actions.some(
        (action) =>
          action.kind === "update" &&
          action.description === "Generate AGENTS.md" &&
          action.destination === agentTarget.destination,
      );
      if (alreadyQueued) continue;

      actions.push({
        kind: "update",
        description: `Generate AGENTS.md`,
        source: agentsMdSrc,
        destination: agentTarget.destination,
        metadata: { provider: agentTarget.provider },
        status: "pending",
      });
    }
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
    for (const target of setupTargets) {
      const overlap = await detectLegacySkillRootOverlap(target.scopeDirs.skillsDir);
      if (!overlap.legacyExists) continue;
      warnings.push(planLegacySkillOverlapMessage(overlap, target.provider));
    }
  }

  return {
    scope,
    provider,
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
