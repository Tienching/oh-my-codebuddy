/**
 * omb setup - Automated installation of oh-my-codebuddy
 * Installs skills, prompts, MCP servers config, and AGENTS.md
 *
 * Refactored to support plan/preview/apply architecture.
 * New modules: src/setup/plan.ts, src/setup/apply.ts, src/setup/config-merger.ts,
 * src/setup/compat-rules.ts, src/setup/installers/
 */

import {
  mkdir,
  copyFile,
  lstat,
  readdir,
  readFile,
  readlink,
  writeFile,
  stat,
  rm,
} from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { createInterface } from "readline/promises";
import { homedir } from "os";
import {
  codebuddyHome,
  codebuddyConfigPath,
  codebuddyPromptsDir,
  codebuddyAgentsDir,
  claudeHome,
  userSkillsDir,
  ombStateDir,
  detectLegacySkillRootOverlap,
  ombPlansDir,
  ombLogsDir,
} from "../utils/paths.js";
import { buildMergedConfig, getRootModelName } from "../config/generator.js";
import {
  ensureOmbManagedConfig,
  migrateLegacyCodebuddyConfigToml,
} from "../setup/migrate-codebuddy-config.js";
import {
  mergeManagedCodebuddyHooksConfig,
  mergeManagedCodexHooksConfig,
  mergeManagedClaudeHooksConfig,
} from "../config/codebuddy-hooks.js";
import {
  getLegacyUnifiedMcpRegistryCandidate,
  getUnifiedMcpRegistryCandidates,
  loadUnifiedMcpRegistry,
  planClaudeCodeMcpSettingsSync,
  type UnifiedMcpRegistryLoadResult,
} from "../config/mcp-registry.js";
import { generateAgentToml } from "../agents/native-config.js";
import { AGENT_DEFINITIONS } from "../agents/definitions.js";
import { getPackageRoot } from "../utils/package.js";
import { readSessionState, isSessionStale } from "../hooks/session.js";
import { getCatalogHeadlineCounts } from "./catalog-contract.js";
import { tryReadCatalogManifest } from "../catalog/reader.js";
import { DEFAULT_FRONTIER_MODEL } from "../config/models.js";
import {
  addGeneratedAgentsMarker,
  isOmbGeneratedAgentsMd,
} from "../utils/agents-md.js";
import {
  resolveAgentsModelTableContext,
  upsertAgentsModelTable,
} from "../utils/agents-model-table.js";
import { spawnPlatformCommandSync } from "../utils/platform-command.js";
import {
  buildSetupBackupContext,
  resolveInstallerRelativePath,
} from "../installer/index.js";
import {
  detectPlatformRuntime,
  formatPlatformRuntime,
} from "../platform/index.js";
import {
  getLegacyScopeMigration,
  getLegacySetupModel,
} from "../setup/compat-rules.js";
import { CLAUDE_BIN, CODEBUDDY_BIN, CODEX_BIN } from "./constants.js";

interface SetupOptions {
  codexVersionProbe?: () => string | null;
  force?: boolean;
  dryRun?: boolean;
  provider?: SetupProvider;
  scope?: SetupScope;
  verbose?: boolean;
  agentsOverwritePrompt?: (destinationPath: string) => Promise<boolean>;
  modelUpgradePrompt?: (
    currentModel: string,
    targetModel: string,
  ) => Promise<boolean>;
  mcpRegistryCandidates?: string[];
}

/**
 * Legacy scope values that may appear in persisted setup-scope.json files.
 * Both 'project-local' (renamed) and old 'project' (minimal, removed) are
 * migrated to the current 'project' scope on read.
 * Now sourced from src/setup/compat-rules.ts
 */
const LEGACY_SCOPE_MIGRATION: Record<string, "project"> = getLegacyScopeMigration();

export const SETUP_SCOPES = ["user", "project"] as const;
export type SetupScope = (typeof SETUP_SCOPES)[number];
export const SETUP_PROVIDERS = ["codebuddy", "codex", "claude", "both", "all"] as const;
export type SetupProvider = (typeof SETUP_PROVIDERS)[number];
type SetupTargetProvider = Exclude<SetupProvider, "both" | "all">;

export interface ScopeDirectories {
  /** @deprecated Use homeDir instead */
  codexConfigFile: string;
  /** @deprecated Use homeDir instead */
  codexHomeDir: string;
  /** @deprecated Use hooksFile instead */
  codexHooksFile: string;
  nativeAgentsDir: string;
  promptsDir: string;
  skillsDir: string;
}

/**
 * Neutral-name view of ScopeDirectories.
 * Maps the legacy codex* field names to neutral names.
 */
export interface ScopeDirectoriesNeutral {
  configFile: string;
  homeDir: string;
  hooksFile: string;
  nativeAgentsDir: string;
  promptsDir: string;
  skillsDir: string;
}

/**
 * Convert ScopeDirectories to neutral-name view.
 */
export function toNeutralScopeDirectories(
  dirs: ScopeDirectories,
): ScopeDirectoriesNeutral {
  return {
    configFile: dirs.codexConfigFile,
    homeDir: dirs.codexHomeDir,
    hooksFile: dirs.codexHooksFile,
    nativeAgentsDir: dirs.nativeAgentsDir,
    promptsDir: dirs.promptsDir,
    skillsDir: dirs.skillsDir,
  };
}

interface SetupCategorySummary {
  updated: number;
  unchanged: number;
  backedUp: number;
  skipped: number;
  removed: number;
}

interface SetupRunSummary {
  prompts: SetupCategorySummary;
  skills: SetupCategorySummary;
  nativeAgents: SetupCategorySummary;
  agentsMd: SetupCategorySummary;
  config: SetupCategorySummary;
}

interface SetupBackupContext {
  backupRoot: string;
  baseRoot: string;
}

interface ManagedConfigResult {
  finalConfig: string;
  ombManagesTui: boolean;
}

interface LegacySkillOverlapNotice {
  shouldWarn: boolean;
  message: string;
}

export interface SkillFrontmatterMetadata {
  name: string;
  description: string;
}

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

function applyScopePathRewritesToAgentsTemplate(
  content: string,
  scope: SetupScope,
  provider: SetupProvider,
): string {
  if (scope === "project") {
    if (provider === "both") {
      return content
        .replaceAll("~/.codebuddy", "./.codebuddy")
        .replaceAll("~/.codex", "./.codex");
    }
    if (provider === "all") {
      return content
        .replaceAll("~/.codebuddy", "./.codebuddy")
        .replaceAll("~/.codex", "./.codex")
        .replaceAll("~/.claude", "./.claude");
    }
    const projectHome = providerHomeLabel(provider, "project");
    return content
      .replaceAll("~/.codebuddy", projectHome)
      .replaceAll("~/.codex", projectHome)
      .replaceAll("~/.claude", projectHome);
  }

  if (provider === "both") return content;
  if (provider === "all") return content;
  const userHome = providerHomeLabel(provider, "user");
  return content
    .replaceAll("~/.codebuddy", userHome)
    .replaceAll("~/.codex", userHome)
    .replaceAll("~/.claude", userHome);
}

interface PersistedSetupScope {
  scope: SetupScope;
  provider?: SetupProvider;
}

async function ensureScopedSettingsJson(
  codexHomeDir: string,
  resolvedConfigToml: string,
  options: { dryRun?: boolean; verbose?: boolean } = {},
): Promise<void> {
  const settingsPath = join(codexHomeDir, "settings.json");
  if (existsSync(settingsPath)) return;

  const model = getRootModelName(resolvedConfigToml);
  const content = JSON.stringify(model ? { model } : {}, null, 2) + "\n";

  if (options.verbose) {
    console.log(`  bootstrap settings.json -> ${settingsPath}`);
  }
  if (options.dryRun) return;

  await mkdir(codexHomeDir, { recursive: true });
  await writeFile(settingsPath, content, "utf-8");
}

interface ResolvedSetupScope {
  scope: SetupScope;
  source: "cli" | "persisted" | "prompt" | "default";
}

interface ResolvedSetupProvider {
  provider: SetupProvider;
  source: "cli" | "persisted" | "default";
}

const REQUIRED_TEAM_CLI_API_MARKERS = [
  "if (subcommand === 'api')",
  "executeTeamApiOperation",
  "TEAM_API_OPERATIONS",
] as const;
const LEGACY_CLAUDE_AGENTS_SIGNATURES = [
  "# CLAUDE.md",
  "Behavioral guidelines to reduce common LLM coding mistakes",
  "## 1. Think Before Coding",
  "## 2. Simplicity First",
  "## 3. Surgical Changes",
  "## 4. Goal-Driven Execution",
] as const;

const DEFAULT_SETUP_SCOPE: SetupScope = "user";
const LEGACY_SETUP_MODEL = getLegacySetupModel();
const DEFAULT_SETUP_MODEL = DEFAULT_FRONTIER_MODEL;
const OBSOLETE_NATIVE_AGENT_FIELD = ["skill", "ref"].join("_");
const TUI_OWNED_BY_CODEX_VERSION = [0, 107, 0] as const;

function createEmptyCategorySummary(): SetupCategorySummary {
  return {
    updated: 0,
    unchanged: 0,
    backedUp: 0,
    skipped: 0,
    removed: 0,
  };
}

function createEmptyRunSummary(): SetupRunSummary {
  return {
    prompts: createEmptyCategorySummary(),
    skills: createEmptyCategorySummary(),
    nativeAgents: createEmptyCategorySummary(),
    agentsMd: createEmptyCategorySummary(),
    config: createEmptyCategorySummary(),
  };
}

function mergeCategorySummary(
  target: SetupCategorySummary,
  source: SetupCategorySummary,
): void {
  target.updated += source.updated;
  target.unchanged += source.unchanged;
  target.backedUp += source.backedUp;
  target.skipped += source.skipped;
  target.removed += source.removed;
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

function codexProviderHome(): string {
  const explicit = String(process.env.CODEX_HOME ?? "").trim();
  return explicit !== "" ? explicit : join(homedir(), ".codex");
}

function providerHomeLabel(
  provider: SetupTargetProvider,
  scope: SetupScope,
): string {
  const prefix = scope === "project" ? "./" : "~/";
  switch (provider) {
    case "codebuddy":
      return `${prefix}.codebuddy`;
    case "codex":
      return `${prefix}.codex`;
    case "claude":
      return `${prefix}.claude`;
  }
}

function providerProjectDirName(provider: SetupTargetProvider): string {
  switch (provider) {
    case "codebuddy":
      return ".codebuddy";
    case "codex":
      return ".codex";
    case "claude":
      return ".claude";
  }
}

function providerBinary(provider: SetupTargetProvider): string {
  switch (provider) {
    case "codebuddy":
      return CODEBUDDY_BIN;
    case "codex":
      return CODEX_BIN;
    case "claude":
      return CLAUDE_BIN;
  }
}

async function ensureBackup(
  destinationPath: string,
  contentChanged: boolean,
  backupContext: SetupBackupContext,
  options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<boolean> {
  if (!contentChanged || !existsSync(destinationPath)) return false;

  const safeRelativePath = resolveInstallerRelativePath(
    backupContext.baseRoot,
    destinationPath,
  );
  const backupPath = join(backupContext.backupRoot, safeRelativePath);

  if (!options.dryRun) {
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(destinationPath, backupPath);
  }
  if (options.verbose) {
    console.log(`  backup ${destinationPath} -> ${backupPath}`);
  }
  return true;
}

async function filesDiffer(src: string, dst: string): Promise<boolean> {
  if (!existsSync(dst)) return true;
  const [srcContent, dstContent] = await Promise.all([
    readFile(src, "utf-8"),
    readFile(dst, "utf-8"),
  ]);
  return srcContent !== dstContent;
}

function containsTomlKey(content: string, key: string): boolean {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escapedKey}\\s*=`, "m").test(content);
}

function parseSkillFrontmatterScalar(
  value: string,
  key: string,
  filePath: string,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${filePath} frontmatter "${key}" must not be empty`);
  }
  if (trimmed === "|" || trimmed === ">") {
    throw new Error(
      `${filePath} frontmatter "${key}" must be a single-line string`,
    );
  }

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    if (trimmed.length < 2 || trimmed.at(-1) !== quote) {
      throw new Error(
        `${filePath} frontmatter "${key}" has an unterminated quoted string`,
      );
    }
    const unquoted = trimmed.slice(1, -1).trim();
    if (!unquoted) {
      throw new Error(`${filePath} frontmatter "${key}" must not be empty`);
    }
    return unquoted;
  }

  const unquoted = trimmed.replace(/\s+#.*$/, "").trim();
  if (!unquoted) {
    throw new Error(`${filePath} frontmatter "${key}" must not be empty`);
  }
  return unquoted;
}

export function parseSkillFrontmatter(
  content: string,
  filePath = "SKILL.md",
): SkillFrontmatterMetadata {
  const frontmatterMatch = content.match(
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
  );
  if (!frontmatterMatch) {
    throw new Error(
      `${filePath} must start with YAML frontmatter containing non-empty name and description fields`,
    );
  }

  let name: string | undefined;
  let description: string | undefined;
  const lines = frontmatterMatch[1].split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\s/.test(rawLine)) continue;

    const match = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!match) {
      throw new Error(
        `${filePath} has invalid YAML frontmatter on line ${index + 2}: ${trimmed}`,
      );
    }

    const [, key, rawValue] = match;
    if (!rawValue.trim()) continue;

    const parsedValue = parseSkillFrontmatterScalar(rawValue, key, filePath);
    if (key === "name") name = parsedValue;
    if (key === "description") description = parsedValue;
  }

  if (!name) {
    throw new Error(`${filePath} is missing a non-empty frontmatter "name"`);
  }
  if (!description) {
    throw new Error(
      `${filePath} is missing a non-empty frontmatter "description"`,
    );
  }

  return { name, description };
}

export async function validateSkillFile(skillMdPath: string): Promise<void> {
  const content = await readFile(skillMdPath, "utf-8");
  parseSkillFrontmatter(content, skillMdPath);
}

async function buildLegacySkillOverlapNotice(
  scope: SetupScope,
  provider: SetupTargetProvider,
): Promise<LegacySkillOverlapNotice> {
  if (scope !== "user") {
    return { shouldWarn: false, message: "" };
  }
  const providerName = providerDisplayName(provider);

  const canonicalDir = (() => {
    switch (provider) {
      case "codebuddy":
        return userSkillsDir();
      case "codex":
        return join(codexProviderHome(), "skills");
      case "claude":
        return join(claudeHome(), "skills");
    }
  })();
  const overlap = await detectLegacySkillRootOverlap(canonicalDir);
  if (!overlap.legacyExists) {
    return { shouldWarn: false, message: "" };
  }

  if (overlap.overlappingSkillNames.length === 0) {
    return {
      shouldWarn: true,
      message:
        `Legacy ~/.agents/skills still exists (${overlap.legacySkillCount} skills) alongside canonical ${overlap.canonicalDir}. ${providerName} may still discover both roots; archive or remove ~/.agents/skills if Enable/Disable Skills shows duplicates.`,
    };
  }

  const mismatchSuffix = overlap.mismatchedSkillNames.length > 0
    ? ` ${overlap.mismatchedSkillNames.length} overlapping skills have different SKILL.md content.`
    : "";
  return {
    shouldWarn: true,
    message:
      `Detected ${overlap.overlappingSkillNames.length} overlapping skill names between canonical ${overlap.canonicalDir} and legacy ${overlap.legacyDir}.${mismatchSuffix} Remove or archive ~/.agents/skills after confirming ${overlap.canonicalDir} is the version you want ${providerName} to load.`,
  };
}

function logCategorySummary(name: string, summary: SetupCategorySummary): void {
  console.log(
    `  ${name}: updated=${summary.updated}, unchanged=${summary.unchanged}, ` +
      `backed_up=${summary.backedUp}, skipped=${summary.skipped}, removed=${summary.removed}`,
  );
}

function isSetupScope(value: string): value is SetupScope {
  return SETUP_SCOPES.includes(value as SetupScope);
}

function isSetupProvider(value: string): value is SetupProvider {
  return SETUP_PROVIDERS.includes(value as SetupProvider);
}

function isLegacyClaudeOnlyAgentsMd(content: string): boolean {
  return (
    !isOmbGeneratedAgentsMd(content) &&
    !content.includes("<keyword_detection>") &&
    LEGACY_CLAUDE_AGENTS_SIGNATURES.every((signature) =>
      content.includes(signature),
    )
  );
}

function getScopeFilePath(projectRoot: string): string {
  return join(projectRoot, ".omb", "setup-scope.json");
}

function getLegacyScopeFilePath(projectRoot: string): string {
  return join(projectRoot, ".omb", "setup-scope.json");
}

export function resolveScopeDirectories(
  scope: SetupScope,
  projectRoot: string,
  provider: SetupProvider = "codebuddy",
): ScopeDirectories {
  const concreteProvider =
    provider === "both" || provider === "all" ? "codebuddy" : provider;
  if (scope === "project") {
    const codexHomeDir = join(projectRoot, providerProjectDirName(concreteProvider));
    return {
      codexConfigFile: join(codexHomeDir, "config.toml"),
      codexHomeDir,
      // Claude CLI reads hooks from `<home>/hooks/hooks.json` (subdirectory)
      // for both user and project scope; codebuddy/codex keep the flat layout.
      codexHooksFile:
        concreteProvider === "claude"
          ? join(codexHomeDir, "hooks", "hooks.json")
          : join(codexHomeDir, "hooks.json"),
      nativeAgentsDir: join(codexHomeDir, "agents"),
      promptsDir: join(codexHomeDir, "prompts"),
      skillsDir: join(codexHomeDir, "skills"),
    };
  }
  if (concreteProvider === "codex") {
    const codexHomeDir = codexProviderHome();
    return {
      codexConfigFile: join(codexHomeDir, "config.toml"),
      codexHomeDir,
      codexHooksFile: join(codexHomeDir, "hooks.json"),
      nativeAgentsDir: join(codexHomeDir, "agents"),
      promptsDir: join(codexHomeDir, "prompts"),
      skillsDir: join(codexHomeDir, "skills"),
    };
  }
  if (concreteProvider === "claude") {
    const claudeHomeDir = claudeHome();
    return {
      codexConfigFile: join(claudeHomeDir, "config.toml"),
      codexHomeDir: claudeHomeDir,
      // Claude CLI reads hooks from `<home>/hooks/hooks.json` (subdirectory),
      // not a flat `<home>/hooks.json`. This path matches the Claude native contract
      // and mirrors the OMC install layout.
      codexHooksFile: join(claudeHomeDir, "hooks", "hooks.json"),
      nativeAgentsDir: join(claudeHomeDir, "agents"),
      promptsDir: join(claudeHomeDir, "prompts"),
      skillsDir: join(claudeHomeDir, "skills"),
    };
  }
  return {
    codexConfigFile: codebuddyConfigPath(),
    codexHomeDir: codebuddyHome(),
    codexHooksFile: join(codebuddyHome(), "hooks.json"),
    nativeAgentsDir: codebuddyAgentsDir(),
    promptsDir: codebuddyPromptsDir(),
    skillsDir: userSkillsDir(),
  };
}

function resolveSetupTargetDirectories(
  scope: SetupScope,
  projectRoot: string,
  provider: SetupProvider,
): Array<{ provider: SetupTargetProvider; scopeDirs: ScopeDirectories }> {
  return setupProviderTargets(provider).map((targetProvider) => ({
    provider: targetProvider,
    scopeDirs: resolveScopeDirectories(scope, projectRoot, targetProvider),
  }));
}

async function removeManagedLegacyProjectCodexAlias(
  projectRoot: string,
  options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<void> {
  const legacyCodexDir = join(projectRoot, ".codex");
  if (!existsSync(legacyCodexDir)) return;
  try {
    const linkStat = await lstat(legacyCodexDir);
    if (!linkStat.isSymbolicLink()) return;
    const linkTarget = await readlink(legacyCodexDir);
    if (linkTarget !== ".codebuddy" && !linkTarget.endsWith("/.codebuddy")) {
      return;
    }
    if (options.verbose) {
      console.log(`  remove legacy project alias ${legacyCodexDir} -> ${linkTarget}`);
    }
    if (!options.dryRun) {
      await rm(legacyCodexDir, { force: true });
    }
  } catch {
    // Best-effort migration cleanup only; setup should still continue.
  }
}

async function readPersistedSetupPreferences(
  projectRoot: string,
): Promise<Partial<PersistedSetupScope> | undefined> {
  const scopePaths = [getScopeFilePath(projectRoot), getLegacyScopeFilePath(projectRoot)];
  for (const scopePath of scopePaths) {
    if (!existsSync(scopePath)) continue;
    try {
      const raw = await readFile(scopePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PersistedSetupScope>;
      const persisted: Partial<PersistedSetupScope> = {};
      if (parsed && typeof parsed.scope === "string") {
        if (isSetupScope(parsed.scope)) {
          persisted.scope = parsed.scope;
        }
        const migrated = LEGACY_SCOPE_MIGRATION[parsed.scope];
        if (migrated) {
          console.warn(
            `[omb] Migrating persisted setup scope "${parsed.scope}" → "${migrated}" ` +
              `(see issue #243: simplified to user/project).`,
          );
          persisted.scope = migrated;
        }
      }
      if (
        parsed &&
        typeof parsed.provider === "string" &&
        isSetupProvider(parsed.provider)
      ) {
        persisted.provider = parsed.provider;
      }
      if (Object.keys(persisted).length > 0) {
        return persisted;
      }
    } catch {
      // ignore invalid persisted scope and fall back to next/default
    }
  }
  return undefined;
}

async function promptForSetupScope(
  defaultScope: SetupScope,
): Promise<SetupScope> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultScope;
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log("Select setup scope:");
    console.log(
      `  1) user (default) — installs to the selected provider home`,
    );
    console.log("  2) project — installs to the selected project provider home");
    const answer = (await rl.question("Scope [1-2] (default: 1): "))
      .trim()
      .toLowerCase();
    if (answer === "2" || answer === "project") return "project";
    return defaultScope;
  } finally {
    rl.close();
  }
}

async function promptForModelUpgrade(
  currentModel: string,
  targetModel: string,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (
      await rl.question(
        `Detected model "${currentModel}". Update to "${targetModel}"? [Y/n]: `,
      )
    )
      .trim()
      .toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function parseSemverTriplet(version: string): [number, number, number] | null {
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

function probeInstalledCliVersion(provider: SetupTargetProvider): string | null {
  const binary = providerBinary(provider);
  const { result } = spawnPlatformCommandSync(binary, ["--version"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  const stdout = (result.stdout || "").trim();
  return stdout === "" ? null : stdout;
}

function shouldOmbManageTuiFromCodexVersion(versionOutput: string | null): boolean {
  if (!versionOutput) return true;
  const parsed = parseSemverTriplet(versionOutput);
  if (!parsed) return true;
  return !semverGte(parsed, TUI_OWNED_BY_CODEX_VERSION);
}

async function promptForAgentsOverwrite(
  destinationPath: string,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (
      await rl.question(
        `Overwrite existing AGENTS.md at "${destinationPath}"? [y/N]: `,
      )
    )
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function resolveSetupScope(
  projectRoot: string,
  requestedScope?: SetupScope,
): Promise<ResolvedSetupScope> {
  if (requestedScope) {
    return { scope: requestedScope, source: "cli" };
  }
  const persisted = await readPersistedSetupPreferences(projectRoot);
  if (persisted?.scope) {
    return { scope: persisted.scope, source: "persisted" };
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const scope = await promptForSetupScope(DEFAULT_SETUP_SCOPE);
    return { scope, source: "prompt" };
  }
  return { scope: DEFAULT_SETUP_SCOPE, source: "default" };
}

async function resolveSetupProvider(
  projectRoot: string,
  requestedProvider?: SetupProvider,
): Promise<ResolvedSetupProvider> {
  if (requestedProvider) {
    return { provider: requestedProvider, source: "cli" };
  }
  const persisted = await readPersistedSetupPreferences(projectRoot);
  if (persisted?.provider) {
    return { provider: persisted.provider, source: "persisted" };
  }
  return { provider: "codebuddy", source: "default" };
}

function hasGitignoreEntry(content: string, entry: string): boolean {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === entry);
}

function stripLegacyGitignoreEntries(
  content: string,
  legacyEntries: readonly string[],
): { content: string; removed: boolean } {
  const legacyEntrySet = new Set(legacyEntries);
  const lines = content.split(/\r?\n/);
  const filteredLines = lines.filter((line) => !legacyEntrySet.has(line.trim()));
  const removed = filteredLines.length !== lines.length;

  return {
    content: filteredLines.join("\n").replace(/\n+$/, "\n"),
    removed,
  };
}

async function ensureProjectGitignore(
  projectRoot: string,
  backupContext: SetupBackupContext,
  options: Pick<SetupOptions, "dryRun" | "verbose">,
  provider: SetupProvider,
): Promise<"created" | "updated" | "unchanged"> {
  const gitignorePath = join(projectRoot, ".gitignore");
  const projectGitignoreEntries = [
    ...PROJECT_GITIGNORE_BASE_ENTRIES,
    ...(provider === "codex" || provider === "claude" ? [] : PROJECT_CODEBUDDY_GITIGNORE_ENTRIES),
    ...(provider === "codebuddy" || provider === "claude" ? [] : PROJECT_CODEX_GITIGNORE_ENTRIES),
    ...(provider === "codebuddy" || provider === "codex" || provider === "both" ? [] : PROJECT_CLAUDE_GITIGNORE_ENTRIES),
  ];
  const destinationExists = existsSync(gitignorePath);
  const existing = destinationExists
    ? await readFile(gitignorePath, "utf-8")
    : "";
  const normalized = stripLegacyGitignoreEntries(
    existing,
    LEGACY_PROJECT_GITIGNORE_ENTRIES,
  );

  const missingEntries = projectGitignoreEntries.filter(
    (entry) => !hasGitignoreEntry(normalized.content, entry),
  );

  if (missingEntries.length === 0 && !normalized.removed) {
    return "unchanged";
  }

  const nextContent = destinationExists
    ? `${normalized.content}${normalized.content.endsWith("\n") || normalized.content.length === 0 ? "" : "\n"}${missingEntries.join("\n")}${missingEntries.length > 0 ? "\n" : ""}`
    : `${projectGitignoreEntries.join("\n")}\n`;

  if (
    await ensureBackup(gitignorePath, destinationExists, backupContext, options)
  ) {
    // backup created when refreshing a pre-existing .gitignore
  }

  if (!options.dryRun) {
    await writeFile(gitignorePath, nextContent);
  }

  if (options.verbose) {
    const changedDetails = [
      normalized.removed ? "removed legacy top-level ignore for .codex/.codebuddy" : "",
      missingEntries.length > 0 ? missingEntries.join(", ") : "",
    ]
      .filter(Boolean)
      .join("; ");
    console.log(
      `  ${options.dryRun ? "would update" : destinationExists ? "updated" : "created"} .gitignore${changedDetails ? ` (${changedDetails})` : ""}`,
    );
  }

  return destinationExists ? "updated" : "created";
}

async function persistSetupScope(
  projectRoot: string,
  scope: SetupScope,
  provider: SetupProvider,
  options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<void> {
  const scopePath = getScopeFilePath(projectRoot);
  if (options.dryRun) {
    if (options.verbose) console.log(`  dry-run: skip persisting ${scopePath}`);
    return;
  }
  await mkdir(dirname(scopePath), { recursive: true });
  const payload: PersistedSetupScope = { scope, provider };
  await writeFile(scopePath, JSON.stringify(payload, null, 2) + "\n");
  if (options.verbose) console.log(`  Wrote ${scopePath}`);
}

export async function setup(options: SetupOptions = {}): Promise<void> {
  const {
    force = false,
    dryRun = false,
    provider: requestedProvider,
    scope: requestedScope,
    verbose = false,
    modelUpgradePrompt,
  } = options;
  const pkgRoot = getPackageRoot();
  const projectRoot = process.cwd();
  const resolvedScope = await resolveSetupScope(projectRoot, requestedScope);
  const resolvedProvider = await resolveSetupProvider(
    projectRoot,
    requestedProvider,
  );
  const setupTargets = resolveSetupTargetDirectories(
    resolvedScope.scope,
    projectRoot,
    resolvedProvider.provider,
  );
  const primaryTarget = setupTargets[0]!;
  const scopeSourceMessage =
    resolvedScope.source === "persisted" ? " (from .omb/setup-scope.json)" : "";
  const providerSourceMessage =
    resolvedProvider.source === "persisted"
      ? " (from .omb/setup-scope.json)"
      : "";
  const backupContext = buildSetupBackupContext(
    resolvedScope.scope,
    projectRoot,
  );

  console.log("oh-my-codebuddy setup");
  console.log("=================\n");
  console.log(
    `Using setup scope: ${resolvedScope.scope}${scopeSourceMessage}\n`,
  );
  console.log(
    `Using setup provider: ${resolvedProvider.provider}${providerSourceMessage}\n`,
  );
  if (verbose) {
    console.log(`Platform runtime: ${formatPlatformRuntime(detectPlatformRuntime())}\n`);
  }

  if (
    resolvedScope.scope === "project" &&
    resolvedProvider.provider !== "codebuddy"
  ) {
    await removeManagedLegacyProjectCodexAlias(projectRoot, {
      dryRun,
      verbose,
    });
  }

  // Step 1: Ensure directories exist
  console.log("[1/8] Creating directories...");
  const dirs = [
    ...setupTargets.flatMap((target) => [
      target.scopeDirs.codexHomeDir,
      target.scopeDirs.promptsDir,
      target.scopeDirs.skillsDir,
      target.scopeDirs.nativeAgentsDir,
    ]),
    ombStateDir(projectRoot),
    ombPlansDir(projectRoot),
    ombLogsDir(projectRoot),
  ];
  for (const dir of new Set(dirs)) {
    if (!dryRun) {
      await mkdir(dir, { recursive: true });
    }
    if (verbose) console.log(`  mkdir ${dir}`);
  }
  await persistSetupScope(projectRoot, resolvedScope.scope, resolvedProvider.provider, {
    dryRun,
    verbose,
  });
  console.log("  Done.\n");

  if (resolvedScope.scope === "project") {
    const gitignoreResult = await ensureProjectGitignore(
      projectRoot,
      backupContext,
      { dryRun, verbose },
      resolvedProvider.provider,
    );
    const trackableProviderPaths = (() => {
      switch (resolvedProvider.provider) {
        case "codebuddy":
          return ".codebuddy agents, skills, and prompts";
        case "codex":
          return ".codex agents, skills, and prompts";
        case "claude":
          return ".claude agents, skills, and prompts";
        case "both":
          return ".codebuddy/.codex agents, skills, and prompts";
        case "all":
          return ".codebuddy/.codex/.claude agents, skills, and prompts";
      }
    })();
    if (gitignoreResult === "created") {
      console.log(
        `  Created .gitignore with OMB project ignore rules so local runtime state stays out of source control while ${trackableProviderPaths} remain trackable.\n`,
      );
    } else if (gitignoreResult === "updated") {
      console.log(
        `  Updated .gitignore with OMB project ignore rules so local runtime state stays out of source control while ${trackableProviderPaths} remain trackable.\n`,
      );
    }
  }

  const catalogCounts = getCatalogHeadlineCounts();
  const summary = createEmptyRunSummary();

  // Step 2: Install agent prompts
  console.log("[2/8] Installing agent prompts...");
  {
    const promptsSrc = join(pkgRoot, "prompts");
    for (const target of setupTargets) {
      const promptsDst = target.scopeDirs.promptsDir;
      const targetSummary = await installPrompts(
        promptsSrc,
        promptsDst,
        backupContext,
        { force, dryRun, verbose },
      );
      mergeCategorySummary(summary.prompts, targetSummary);
      const cleanedLegacyPromptShims = await cleanupLegacySkillPromptShims(
        promptsSrc,
        promptsDst,
        {
          dryRun,
          verbose,
        },
      );
      summary.prompts.removed += cleanedLegacyPromptShims;
      if (cleanedLegacyPromptShims > 0) {
        if (dryRun) {
          console.log(
            `  Would remove ${cleanedLegacyPromptShims} legacy skill prompt shim file(s) from ${promptsDst}.`,
          );
        } else {
          console.log(
            `  Removed ${cleanedLegacyPromptShims} legacy skill prompt shim file(s) from ${promptsDst}.`,
          );
        }
      }
    }
    if (catalogCounts) {
      console.log(
        `  Prompt refresh complete (catalog baseline: ${catalogCounts.prompts}).\n`,
      );
    } else {
      console.log("  Prompt refresh complete.\n");
    }
  }

  // Step 3: Install skills
  console.log("[3/8] Installing skills...");
  {
    const skillsSrc = join(pkgRoot, "skills");
    for (const target of setupTargets) {
      const skillsDst = target.scopeDirs.skillsDir;
      const targetSummary = await installSkills(skillsSrc, skillsDst, backupContext, {
        force,
        dryRun,
        verbose,
      });
      mergeCategorySummary(summary.skills, targetSummary);
    }
    if (catalogCounts) {
      console.log(
        `  Skill refresh complete (catalog baseline: ${catalogCounts.skills}).\n`,
      );
    } else {
      console.log("  Skill refresh complete.\n");
    }
  }

  // Step 4: Install native agent configs
  console.log("[4/8] Installing native agent configs...");
  {
    for (const target of setupTargets) {
      const targetSummary = await refreshNativeAgentConfigs(
        pkgRoot,
        target.scopeDirs.nativeAgentsDir,
        backupContext,
        {
          force,
          dryRun,
          verbose,
        },
      );
      mergeCategorySummary(summary.nativeAgents, targetSummary);
      console.log(
        `  Native agent refresh complete (${target.scopeDirs.nativeAgentsDir}).`,
      );
    }
    console.log();
  }

  // Step 5: Update provider configuration
  console.log("[5/8] Updating provider configuration...");
  const registryCandidates = getUnifiedMcpRegistryCandidates();
  const defaultRegistryCandidates = registryCandidates.slice(0, 1);
  const legacyRegistryCandidate = getLegacyUnifiedMcpRegistryCandidate();
  const sharedMcpRegistry = await loadUnifiedMcpRegistry({
    candidates: options.mcpRegistryCandidates ?? defaultRegistryCandidates,
  });
  if (
    !options.mcpRegistryCandidates &&
    !sharedMcpRegistry.sourcePath &&
    existsSync(legacyRegistryCandidate) &&
    !existsSync(defaultRegistryCandidates[0])
  ) {
    console.log(
      `  warning: legacy shared MCP registry detected at ${legacyRegistryCandidate} but ignored by default; move it to ${defaultRegistryCandidates[0]} if you still want setup to sync those servers`,
    );
  }
  if (verbose && sharedMcpRegistry.sourcePath) {
    console.log(
      `  shared MCP registry: ${sharedMcpRegistry.sourcePath} (${sharedMcpRegistry.servers.length} servers)`,
    );
  }
  for (const warning of sharedMcpRegistry.warnings) {
    console.log(`  warning: ${warning}`);
  }
  const managedConfigs = new Map<SetupTargetProvider, ManagedConfigResult>();
  for (const target of setupTargets) {
    const managedConfig = await updateManagedConfig(
      target.scopeDirs.codexConfigFile,
      pkgRoot,
      sharedMcpRegistry,
      summary.config,
      backupContext,
      {
        codexVersionProbe: options.codexVersionProbe,
        dryRun,
        verbose,
        modelUpgradePrompt,
        setupProvider: target.provider,
      },
    );
    managedConfigs.set(target.provider, managedConfig);
    await ensureScopedSettingsJson(
      target.scopeDirs.codexHomeDir,
      managedConfig.finalConfig,
      {
        dryRun,
        verbose,
      },
    );
    switch (target.provider) {
      case "codex":
        console.log(`  Config refresh complete (${target.scopeDirs.codexConfigFile}).`);
        break;
      case "codebuddy":
      case "claude":
        console.log(`  Config refresh complete (${join(target.scopeDirs.codexHomeDir, ".omb-config.json")}).`);
        break;
    }
    // Claude CLI does NOT read MCP servers from `~/.claude/settings.json#mcpServers`.
    // It reads them from `claude mcp add` managed state (~/.claude/.claude.json or
    // ~/.claude-internal/.claude.json on Internal builds) or from project `.mcp.json`.
    // OMB therefore does not write MCP settings for the claude provider at setup time;
    // MCP integration for claude is tracked as a follow-up (skill-packaged MCP clients).
    // See: prd-claude-leader-provider.md §9 out-of-scope follow-ups.
  }
  if (resolvedScope.scope === "user") {
    await syncClaudeCodeMcpSettings(
      sharedMcpRegistry,
      summary.config,
      backupContext,
      { dryRun, verbose },
    );
  }
  console.log();

  for (const target of setupTargets) {
    const existingHooksContent = existsSync(target.scopeDirs.codexHooksFile)
      ? await readFile(target.scopeDirs.codexHooksFile, "utf-8")
      : null;
    const hooksConfig = (() => {
      switch (target.provider) {
        case "codebuddy":
          return mergeManagedCodebuddyHooksConfig(existingHooksContent, pkgRoot);
        case "codex":
          return mergeManagedCodexHooksConfig(existingHooksContent, pkgRoot);
        case "claude":
          return mergeManagedClaudeHooksConfig(existingHooksContent, pkgRoot);
      }
    })();
    await syncManagedContent(
      hooksConfig,
      target.scopeDirs.codexHooksFile,
      summary.config,
      backupContext,
      { dryRun, verbose },
      `native hooks ${target.scopeDirs.codexHooksFile}`,
    );
    console.log(
      `  Native ${providerDisplayName(target.provider)} hooks refresh complete (${target.scopeDirs.codexHooksFile}).`,
    );
  }
  console.log();

  // Step 5.5: Verify team CLI interop surface is available.
  console.log("[5.5/8] Verifying Team CLI API interop...");
  const teamToolsCheck = await verifyTeamCliApiInterop(pkgRoot);
  if (teamToolsCheck.ok) {
    console.log("  omb team api command detected (legacy omb alias still works; CLI-first interop ready)");
  } else {
    console.log(`  WARNING: ${teamToolsCheck.message}`);
    console.log("  Run `npm run build` and then re-run `omb setup` (legacy: `omb setup`).");
  }
  console.log();

  // Step 6: Generate AGENTS.md
  console.log("[6/8] Generating AGENTS.md...");
  const agentsMdSrc = join(pkgRoot, "templates", "AGENTS.md");
  if (existsSync(agentsMdSrc)) {
    const content = await readFile(agentsMdSrc, "utf-8");
    const agentsMdTargets =
      resolvedScope.scope === "project"
        ? [
            {
              destination: join(projectRoot, "AGENTS.md"),
              provider: resolvedProvider.provider,
              target: primaryTarget,
            },
          ]
        : setupTargets.map((target) => ({
            destination: join(target.scopeDirs.codexHomeDir, "AGENTS.md"),
            provider: target.provider,
            target,
          }));

    const activeSession =
      resolvedScope.scope === "project"
        ? await readSessionState(projectRoot)
        : null;
    const sessionIsActive = activeSession && !isSessionStale(activeSession);

    for (const agentsTarget of agentsMdTargets) {
      const agentsMdDst = agentsTarget.destination;
      const agentsMdExists = existsSync(agentsMdDst);
      const resolvedConfig =
        managedConfigs.get(agentsTarget.target.provider)?.finalConfig ?? "";
      const modelTableContext = resolveAgentsModelTableContext(resolvedConfig, {
        codebuddyHomeOverride: agentsTarget.target.scopeDirs.codexHomeDir,
      });
      const rewritten = upsertAgentsModelTable(
        addGeneratedAgentsMarker(
          applyScopePathRewritesToAgentsTemplate(
            content,
            resolvedScope.scope,
            agentsTarget.provider,
          ),
        ),
        modelTableContext,
      );
      let changed = true;
      let canApplyManagedModelRefresh = false;
      let managedRefreshContent = "";
      if (agentsMdExists) {
        const existing = await readFile(agentsMdDst, "utf-8");
        changed = existing !== rewritten;
        if (isOmbGeneratedAgentsMd(existing)) {
          managedRefreshContent = upsertAgentsModelTable(
            existing,
            modelTableContext,
          );
          canApplyManagedModelRefresh = managedRefreshContent !== existing;
        }
      }

      if (
        resolvedScope.scope === "project" &&
        sessionIsActive &&
        agentsMdExists &&
        changed
      ) {
        summary.agentsMd.skipped += 1;
        console.log(
          "  WARNING: Active omb session detected (pid " +
            activeSession?.pid +
            ").",
        );
        console.log(
          "  Skipping AGENTS.md overwrite to avoid corrupting runtime overlay.",
        );
        console.log("  Stop the active session first, then re-run setup.");
      } else if (canApplyManagedModelRefresh) {
        await syncManagedContent(
          managedRefreshContent,
          agentsMdDst,
          summary.agentsMd,
          backupContext,
          { dryRun, verbose },
          `AGENTS model table ${agentsMdDst}`,
        );
        console.log(
          resolvedScope.scope === "project"
            ? "  Refreshed AGENTS.md model capability table in project root."
            : `  Refreshed AGENTS.md model capability table in ${agentsTarget.target.scopeDirs.codexHomeDir}.`,
        );
      } else {
        const result = await syncManagedAgentsContent(
          rewritten,
          agentsMdDst,
          summary.agentsMd,
          backupContext,
          {
            agentsOverwritePrompt: options.agentsOverwritePrompt,
            dryRun,
            force,
            verbose,
          },
        );

        if (result === "updated") {
          console.log(
            resolvedScope.scope === "project"
              ? "  Generated AGENTS.md in project root."
              : `  Generated AGENTS.md in ${agentsTarget.target.scopeDirs.codexHomeDir}.`,
          );
        } else if (result === "unchanged") {
          console.log(
            resolvedScope.scope === "project"
              ? "  AGENTS.md already up to date in project root."
              : `  AGENTS.md already up to date in ${agentsTarget.target.scopeDirs.codexHomeDir}.`,
          );
        } else if (agentsMdExists) {
          console.log(
            `  Skipped AGENTS.md overwrite for ${agentsMdDst}. Re-run interactively to confirm or use --force.`,
          );
        }
      }
    }
    if (resolvedScope.scope === "user") {
      console.log("  User scope leaves project AGENTS.md unchanged.");
    }
  } else {
    summary.agentsMd.skipped += 1;
    console.log("  AGENTS.md template not found, skipping.");
  }
  console.log();

  // Step 7: Set up notify hook
  console.log("[7/8] Configuring notification hook...");
  await setupNotifyHook(pkgRoot, { dryRun, verbose });
  console.log("  Done.\n");

  // Step 8: Configure HUD
  console.log("[8/8] Configuring HUD...");
  const hudConfigPath = join(projectRoot, ".omb", "hud-config.json");
  if (force || !existsSync(hudConfigPath)) {
    if (!dryRun) {
      const defaultHudConfig = { preset: "focused" };
      await writeFile(hudConfigPath, JSON.stringify(defaultHudConfig, null, 2));
    }
    if (verbose) console.log("  Wrote .omb/hud-config.json");
    console.log("  HUD config created (preset: focused).");
  } else {
    console.log("  HUD config already exists (use --force to overwrite).");
  }
  const anyManagedTui = [...managedConfigs.values()].some(
    (managedConfig) => managedConfig.ombManagesTui,
  );
  if (anyManagedTui) {
    console.log("  StatusLine configured in config.toml via [tui] section.");
  } else if (managedConfigs.has("codex")) {
    console.log("  Codex CLI >= 0.107.0 manages [tui]; OMB left that section untouched.");
  } else {
    console.log("  No provider-native TUI config changes needed.");
  }
  console.log();

  console.log("Setup refresh summary:");
  logCategorySummary("prompts", summary.prompts);
  logCategorySummary("skills", summary.skills);
  logCategorySummary("native_agents", summary.nativeAgents);
  logCategorySummary("agents_md", summary.agentsMd);
  logCategorySummary("config", summary.config);
  console.log();

  const setupProviders = setupProviderTargets(resolvedProvider.provider);
  let legacySkillOverlapPrinted = false;
  for (const targetProvider of setupProviders) {
    const notice = await buildLegacySkillOverlapNotice(
      resolvedScope.scope,
      targetProvider,
    );
    if (!notice.shouldWarn) continue;
    console.log(`Migration hint: ${notice.message}`);
    legacySkillOverlapPrinted = true;
  }
  if (legacySkillOverlapPrinted) {
    console.log();
  }

  if (force) {
    console.log(
      "Force mode: enabled additional destructive maintenance (for example stale deprecated skill cleanup).",
    );
    console.log();
  }

  console.log('Setup complete! Run "omb doctor" to verify installation.');
  console.log("\nNext steps:");
  const cliLabel =
    resolvedProvider.provider === "both"
      ? "CodeBuddy or Codex CLI"
      : resolvedProvider.provider === "all"
        ? "CodeBuddy, Codex, or Claude CLI"
        : `${providerDisplayName(setupProviderTargets(resolvedProvider.provider)[0]!)} CLI`;
  const skillsPathLabel = (() => {
    switch (resolvedProvider.provider) {
      case "codebuddy":
        return ".codebuddy/agents/";
      case "codex":
        return ".codex/agents/";
      case "claude":
        return ".claude/agents/";
      case "both":
        return ".codebuddy/agents/ and .codex/agents/";
      case "all":
        return ".codebuddy/agents/, .codex/agents/, and .claude/agents/";
    }
  })();
  console.log(`  1. Start ${cliLabel} in your project directory`);
  console.log(
    `  2. Use role/workflow keywords like $architect, $executor, and $plan in ${cliLabel}`,
  );
  console.log("  3. Browse skills with /skills; AGENTS keyword routing can also activate them implicitly");
  console.log("  4. The AGENTS.md orchestration brain is loaded automatically");
  console.log(
    `  5. Native agent defaults installed under ${skillsPathLabel}`,
  );
  console.log(
    '  6. "omb explore" and "omb sparkshell" can hydrate native release binaries on first use; the legacy `omb` alias still works, and source installs still allow repo-local fallbacks plus OMB_/OMB_ binary override env vars',
  );
  if (isGitHubCliConfigured()) {
    console.log("\nSupport the project: gh repo star Tienching/oh-my-codebuddy");
  }
}

function isLegacySkillPromptShim(content: string): boolean {
  const marker =
    /Read and follow the full skill instructions at\s+.*\/skills\/[^/\s]+\/SKILL\.md/i;
  return marker.test(content);
}

async function cleanupLegacySkillPromptShims(
  promptsSrcDir: string,
  promptsDstDir: string,
  options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<number> {
  if (!existsSync(promptsSrcDir) || !existsSync(promptsDstDir)) return 0;

  const sourceFiles = new Set(
    (await readdir(promptsSrcDir)).filter((name) => name.endsWith(".md")),
  );

  const installedFiles = await readdir(promptsDstDir);
  let removed = 0;

  for (const file of installedFiles) {
    if (!file.endsWith(".md")) continue;
    if (sourceFiles.has(file)) continue;

    const fullPath = join(promptsDstDir, file);
    let content = "";
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    if (!isLegacySkillPromptShim(content)) continue;

    if (!options.dryRun) {
      await rm(fullPath, { force: true });
    }
    if (options.verbose) console.log(`  removed legacy prompt shim ${file}`);
    removed++;
  }

  return removed;
}

function isGitHubCliConfigured(): boolean {
  const result = spawnSync("gh", ["auth", "status"], { stdio: "ignore",
      windowsHide: true,
    });
  return result.status === 0;
}

async function syncManagedFileFromDisk(
  srcPath: string,
  dstPath: string,
  summary: SetupCategorySummary,
  backupContext: SetupBackupContext,
  options: Pick<SetupOptions, "dryRun" | "verbose">,
  verboseLabel: string,
): Promise<void> {
  const destinationExists = existsSync(dstPath);
  const changed = !destinationExists || (await filesDiffer(srcPath, dstPath));

  if (!changed) {
    summary.unchanged += 1;
    return;
  }

  if (await ensureBackup(dstPath, destinationExists, backupContext, options)) {
    summary.backedUp += 1;
  }

  if (!options.dryRun) {
    await mkdir(dirname(dstPath), { recursive: true });
    await copyFile(srcPath, dstPath);
  }

  summary.updated += 1;
  if (options.verbose) {
    console.log(
      `  ${options.dryRun ? "would update" : "updated"} ${verboseLabel}`,
    );
  }
}

async function syncManagedContent(
  content: string,
  dstPath: string,
  summary: SetupCategorySummary,
  backupContext: SetupBackupContext,
  options: Pick<SetupOptions, "dryRun" | "verbose">,
  verboseLabel: string,
): Promise<void> {
  const destinationExists = existsSync(dstPath);
  let changed = true;
  if (destinationExists) {
    const existing = await readFile(dstPath, "utf-8");
    changed = existing !== content;
  }

  if (!changed) {
    summary.unchanged += 1;
    return;
  }

  if (await ensureBackup(dstPath, destinationExists, backupContext, options)) {
    summary.backedUp += 1;
  }

  if (!options.dryRun) {
    await mkdir(dirname(dstPath), { recursive: true });
    await writeFile(dstPath, content);
  }

  summary.updated += 1;
  if (options.verbose) {
    console.log(
      `  ${options.dryRun ? "would update" : "updated"} ${verboseLabel}`,
    );
  }
}

async function syncManagedAgentsContent(
  content: string,
  dstPath: string,
  summary: SetupCategorySummary,
  backupContext: SetupBackupContext,
  options: Pick<
    SetupOptions,
    "agentsOverwritePrompt" | "dryRun" | "force" | "verbose"
  >,
): Promise<"updated" | "unchanged" | "skipped"> {
  const destinationExists = existsSync(dstPath);
  let existing = "";
  let changed = true;

  if (destinationExists) {
    existing = await readFile(dstPath, "utf-8");
    changed = existing !== content;
  }
  const legacyClaudeOnlyAgentsMd =
    destinationExists && isLegacyClaudeOnlyAgentsMd(existing);

  if (!changed) {
    summary.unchanged += 1;
    return "unchanged";
  }

  if (destinationExists && !options.force && !legacyClaudeOnlyAgentsMd) {
    if (options.dryRun) {
      summary.skipped += 1;
      if (options.verbose) {
        console.log(`  would prompt before overwriting ${dstPath}`);
      }
      return "skipped";
    }

    const shouldOverwrite = options.agentsOverwritePrompt
      ? await options.agentsOverwritePrompt(dstPath)
      : await promptForAgentsOverwrite(dstPath);

    if (!shouldOverwrite) {
      summary.skipped += 1;
      if (options.verbose) {
        const managedLabel = isOmbGeneratedAgentsMd(existing)
          ? "managed"
          : "unmanaged";
        console.log(`  skipped ${managedLabel} AGENTS.md at ${dstPath}`);
      }
      return "skipped";
    }
  }
  if (legacyClaudeOnlyAgentsMd && options.verbose) {
    console.log(
      `  refreshing legacy CLAUDE.md-only AGENTS scaffold at ${dstPath}`,
    );
  }

  if (await ensureBackup(dstPath, destinationExists, backupContext, options)) {
    summary.backedUp += 1;
  }

  if (!options.dryRun) {
    await mkdir(dirname(dstPath), { recursive: true });
    await writeFile(dstPath, content);
  }

  summary.updated += 1;
  if (options.verbose) {
    console.log(
      `  ${options.dryRun ? "would update" : "updated"} AGENTS ${dstPath}`,
    );
  }
  return "updated";
}

async function installPrompts(
  srcDir: string,
  dstDir: string,
  backupContext: SetupBackupContext,
  options: SetupOptions,
): Promise<SetupCategorySummary> {
  const summary = createEmptyCategorySummary();
  if (!existsSync(srcDir)) return summary;

  const manifest = tryReadCatalogManifest();
  const agentStatusByName = manifest
    ? new Map(manifest.agents.map((agent) => [agent.name, agent.status]))
    : null;
  const isInstallableStatus = (status: string | undefined): boolean =>
    status === "active" || status === "internal";

  const files = await readdir(srcDir);
  const staleCandidatePromptNames = new Set(
    manifest?.agents.map((agent) => agent.name) ?? [],
  );

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const promptName = file.slice(0, -3);
    staleCandidatePromptNames.add(promptName);

    const status = agentStatusByName?.get(promptName);
    if (agentStatusByName && !isInstallableStatus(status)) {
      summary.skipped += 1;
      if (options.verbose) {
        const label = status ?? "unlisted";
        console.log(`  skipped ${file} (status: ${label})`);
      }
      continue;
    }

    const src = join(srcDir, file);
    const dst = join(dstDir, file);
    const srcStat = await stat(src);
    if (!srcStat.isFile()) continue;
    await syncManagedFileFromDisk(
      src,
      dst,
      summary,
      backupContext,
      options,
      `prompt ${file}`,
    );
  }

  if (options.force && manifest && existsSync(dstDir)) {
    const installedFiles = await readdir(dstDir);
    for (const file of installedFiles) {
      if (!file.endsWith(".md")) continue;
      const promptName = file.slice(0, -3);
      const status = agentStatusByName?.get(promptName);
      if (isInstallableStatus(status)) continue;
      if (!staleCandidatePromptNames.has(promptName) && status === undefined)
        continue;

      const stalePromptPath = join(dstDir, file);
      if (!existsSync(stalePromptPath)) continue;

      if (!options.dryRun) {
        await rm(stalePromptPath, { force: true });
      }
      summary.removed += 1;
      if (options.verbose) {
        const prefix = options.dryRun
          ? "would remove stale prompt"
          : "removed stale prompt";
        const label = status ?? "unlisted";
        console.log(`  ${prefix} ${file} (status: ${label})`);
      }
    }
  }

  return summary;
}

async function refreshNativeAgentConfigs(
  pkgRoot: string,
  agentsDir: string,
  backupContext: SetupBackupContext,
  options: Pick<SetupOptions, "dryRun" | "verbose" | "force">,
): Promise<SetupCategorySummary> {
  const summary = createEmptyCategorySummary();

  if (!options.dryRun) {
    await mkdir(agentsDir, { recursive: true });
  }

  const manifest = tryReadCatalogManifest();
  const agentStatusByName = manifest
    ? new Map(manifest.agents.map((agent) => [agent.name, agent.status]))
    : null;
  const isInstallableStatus = (status: string | undefined): boolean =>
    status === "active" || status === "internal";
  const staleCandidateNativeAgentNames = new Set(
    manifest?.agents.map((agent) => agent.name) ?? [],
  );

  for (const [name, agent] of Object.entries(AGENT_DEFINITIONS)) {
    staleCandidateNativeAgentNames.add(name);
    const status = agentStatusByName?.get(name);
    if (agentStatusByName && !isInstallableStatus(status)) {
      if (options.verbose) {
        const label = status ?? "unlisted";
        console.log(`  skipped native agent ${name}.toml (status: ${label})`);
      }
      summary.skipped += 1;
      continue;
    }

    const promptPath = join(pkgRoot, "prompts", `${name}.md`);
    if (!existsSync(promptPath)) {
      continue;
    }

    const promptContent = await readFile(promptPath, "utf-8");
    const toml = generateAgentToml(agent, promptContent, {
      codebuddyHomeOverride: join(agentsDir, ".."),
    });
    const dst = join(agentsDir, `${name}.toml`);
    await syncManagedContent(
      toml,
      dst,
      summary,
      backupContext,
      options,
      `native agent ${name}.toml`,
    );
  }

  summary.removed += await cleanupObsoleteNativeAgents(
    agentsDir,
    backupContext,
    options,
  );

  if (options.force && manifest && existsSync(agentsDir)) {
    const installedFiles = await readdir(agentsDir);
    for (const file of installedFiles) {
      if (!file.endsWith(".toml")) continue;
      const agentName = file.slice(0, -5);
      const agentStatus = agentStatusByName?.get(agentName);
      if (isInstallableStatus(agentStatus)) continue;
      if (
        !staleCandidateNativeAgentNames.has(agentName) &&
        agentStatus === undefined
      )
        continue;

      const staleAgentPath = join(agentsDir, file);
      if (!existsSync(staleAgentPath)) continue;

      if (!options.dryRun) {
        await rm(staleAgentPath, { force: true });
      }
      summary.removed += 1;
      if (options.verbose) {
        const prefix = options.dryRun
          ? "would remove stale native agent"
          : "removed stale native agent";
        const label = agentStatus ?? "unlisted";
        console.log(`  ${prefix} ${file} (status: ${label})`);
      }
    }
  }

  return summary;
}

async function cleanupObsoleteNativeAgents(
  agentsDir: string,
  backupContext: SetupBackupContext,
  options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<number> {
  if (!existsSync(agentsDir)) return 0;

  const installedFiles = await readdir(agentsDir);
  let removed = 0;

  for (const file of installedFiles) {
    if (!file.endsWith(".toml")) continue;

    const fullPath = join(agentsDir, file);
    let content = "";
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    if (!containsTomlKey(content, OBSOLETE_NATIVE_AGENT_FIELD)) continue;

    if (await ensureBackup(fullPath, true, backupContext, options)) {
      // backup created for pre-existing obsolete native agent config
    }
    if (!options.dryRun) {
      await rm(fullPath, { force: true });
    }
    if (options.verbose) {
      const prefix = options.dryRun
        ? "would remove stale obsolete native agent"
        : "removed stale obsolete native agent";
      console.log(`  ${prefix} ${file}`);
    }
    removed += 1;
  }

  return removed;
}

export async function installSkills(
  srcDir: string,
  dstDir: string,
  backupContext: SetupBackupContext,
  options: SetupOptions,
): Promise<SetupCategorySummary> {
  const summary = createEmptyCategorySummary();
  if (!existsSync(srcDir)) return summary;
  const installableSkills: Array<{
    name: string;
    sourceDir: string;
    destinationDir: string;
  }> = [];
  const manifest = tryReadCatalogManifest();
  const skillStatusByName = manifest
    ? new Map(manifest.skills.map((skill) => [skill.name, skill.status]))
    : null;
  const isInstallableStatus = (status: string | undefined): boolean =>
    status === "active" || status === "internal";
  const entries = await readdir(srcDir, { withFileTypes: true });
  const staleCandidateSkillNames = new Set(
    manifest?.skills.map((skill) => skill.name) ?? [],
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    staleCandidateSkillNames.add(entry.name);
    const status = skillStatusByName?.get(entry.name);
    if (skillStatusByName && !isInstallableStatus(status)) {
      summary.skipped += 1;
      if (options.verbose) {
        const label = status ?? "unlisted";
        console.log(`  skipped ${entry.name}/ (status: ${label})`);
      }
      continue;
    }

    const skillSrc = join(srcDir, entry.name);
    const skillDst = join(dstDir, entry.name);
    const skillMd = join(skillSrc, "SKILL.md");
    if (!existsSync(skillMd)) continue;

    installableSkills.push({
      name: entry.name,
      sourceDir: skillSrc,
      destinationDir: skillDst,
    });
  }

  for (const skill of installableSkills) {
    await validateSkillFile(join(skill.sourceDir, "SKILL.md"));
  }

  for (const skill of installableSkills) {
    const skillName = skill.name;
    const skillSrc = skill.sourceDir;
    const skillDst = skill.destinationDir;

    if (!options.dryRun) {
      await mkdir(skillDst, { recursive: true });
    }

    const skillFiles = await readdir(skillSrc);
    for (const sf of skillFiles) {
      const sfPath = join(skillSrc, sf);
      const sfStat = await stat(sfPath);
      if (!sfStat.isFile()) continue;
      const dstPath = join(skillDst, sf);
      await syncManagedFileFromDisk(
        sfPath,
        dstPath,
        summary,
        backupContext,
        options,
        `skill ${skillName}/${sf}`,
      );
    }
  }

  if (options.force && manifest && existsSync(dstDir)) {
    for (const staleSkill of staleCandidateSkillNames) {
      const status = skillStatusByName?.get(staleSkill);
      if (isInstallableStatus(status)) continue;

      const staleSkillDir = join(dstDir, staleSkill);
      if (!existsSync(staleSkillDir)) continue;

      if (!options.dryRun) {
        await rm(staleSkillDir, { recursive: true, force: true });
      }
      summary.removed += 1;
      if (options.verbose) {
        const prefix = options.dryRun
          ? "would remove stale skill"
          : "removed stale skill";
        const label = status ?? "unlisted";
        console.log(`  ${prefix} ${staleSkill}/ (status: ${label})`);
      }
    }
  }

  return summary;
}

async function updateManagedConfig(
  configPath: string,
  pkgRoot: string,
  sharedMcpRegistry: UnifiedMcpRegistryLoadResult,
  summary: SetupCategorySummary,
  backupContext: SetupBackupContext,
  options: Pick<
    SetupOptions,
    "codexVersionProbe" | "dryRun" | "verbose" | "modelUpgradePrompt"
  > & { setupProvider: SetupTargetProvider },
): Promise<ManagedConfigResult> {
  // JSON-native providers (CodeBuddy and Claude): settings.json + hooks.json +
  // .omb-config.json are the active surfaces. A codex-format config.toml here
  // is dead bytes, and its OMB-consumed fields (model_provider /
  // model_providers.env_key) are backed by .omb-config.json.providers (see
  // src/config/models.ts).
  // Do not generate config.toml; migrate the legacy one if present and remove
  // it, then ensure .omb-config.json exists so doctor can tell "setup ran" apart
  // from "fresh CodeBuddy install we've never touched".
  if (options.setupProvider === "codebuddy" || options.setupProvider === "claude") {
    const migrationResult = await migrateLegacyCodebuddyConfigToml({
      legacyConfigPath: configPath,
      dryRun: options.dryRun ?? false,
      verbose: options.verbose ?? false,
    });
    const ensureResult = await ensureOmbManagedConfig({
      codebuddyHome: dirname(configPath),
      dryRun: options.dryRun ?? false,
    });
    if (migrationResult.noop && !ensureResult.wrote) {
      summary.unchanged += 1;
    } else {
      summary.updated += 1;
    }
    // `finalConfig` is "" so downstream consumers (resolveAgentsModelTableContext)
    // fall back to defaults, which matches the "no codex TOML" reality.
    return { finalConfig: "", ombManagesTui: false };
  }

  const existing = existsSync(configPath)
    ? await readFile(configPath, "utf-8")
    : "";
  const currentModel = getRootModelName(existing);
  let modelOverride: string | undefined;
  const codexVersion =
    options.codexVersionProbe?.() ?? probeInstalledCliVersion(options.setupProvider);
  const ombManagesTui = shouldOmbManageTuiFromCodexVersion(codexVersion);

  if (currentModel === LEGACY_SETUP_MODEL) {
    const shouldPrompt =
      typeof options.modelUpgradePrompt === "function" ||
      (process.stdin.isTTY && process.stdout.isTTY);
    if (shouldPrompt) {
      const shouldUpgrade = options.modelUpgradePrompt
        ? await options.modelUpgradePrompt(currentModel, DEFAULT_SETUP_MODEL)
        : await promptForModelUpgrade(currentModel, DEFAULT_SETUP_MODEL);
      if (shouldUpgrade) {
        modelOverride = DEFAULT_SETUP_MODEL;
      }
    }
  }

  const finalConfig = buildMergedConfig(existing, pkgRoot, {
    includeTui: ombManagesTui,
    modelOverride,
    sharedMcpServers: sharedMcpRegistry.servers,
    sharedMcpRegistrySource: sharedMcpRegistry.sourcePath,
    verbose: options.verbose,
  });
  const changed = existing !== finalConfig;

  if (!changed) {
    summary.unchanged += 1;
    return { finalConfig, ombManagesTui };
  }

  if (
    await ensureBackup(
      configPath,
      existsSync(configPath),
      backupContext,
      options,
    )
  ) {
    summary.backedUp += 1;
  }

  if (!options.dryRun) {
    await writeFile(configPath, finalConfig);
  }

  if (
    options.verbose &&
    modelOverride &&
    currentModel &&
    currentModel !== modelOverride
  ) {
    console.log(
      `  ${options.dryRun ? "would update" : "updated"} root model from ${currentModel} to ${modelOverride}`,
    );
  }

  summary.updated += 1;
  if (options.verbose) {
    console.log(
      `  ${options.dryRun ? "would update" : "updated"} config ${configPath}`,
    );
  }
  return { finalConfig, ombManagesTui };
}

function getClaudeCodeSettingsPath(homeDir = homedir()): string {
  return join(homeDir, ".claude", "settings.json");
}

async function syncClaudeCodeMcpSettings(
  sharedMcpRegistry: UnifiedMcpRegistryLoadResult,
  summary: SetupCategorySummary,
  backupContext: SetupBackupContext,
  options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<void> {
  if (sharedMcpRegistry.servers.length === 0) return;

  const settingsPath = getClaudeCodeSettingsPath();
  const existing = existsSync(settingsPath)
    ? await readFile(settingsPath, "utf-8")
    : "";
  const syncPlan = planClaudeCodeMcpSettingsSync(
    existing,
    sharedMcpRegistry.servers,
  );

  for (const warning of syncPlan.warnings) {
    console.log(`  warning: ${warning}`);
  }
  if (syncPlan.warnings.length > 0) {
    summary.skipped += 1;
    return;
  }
  if (!syncPlan.content) {
    summary.unchanged += 1;
    if (options.verbose && syncPlan.unchanged.length > 0) {
      console.log(
        `  shared MCP servers already present in Claude Code settings (${settingsPath})`,
      );
    }
    return;
  }

  await syncManagedContent(
    syncPlan.content,
    settingsPath,
    summary,
    backupContext,
    options,
    `Claude Code MCP settings ${settingsPath} (+${syncPlan.added.join(", ")})`,
  );
}

async function setupNotifyHook(
  pkgRoot: string,
  options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<void> {
  const hookScript = join(pkgRoot, "dist", "scripts", "notify-hook.js");
  if (!existsSync(hookScript)) {
    if (options.verbose)
      console.log("  Notify hook script not found, skipping.");
    return;
  }
  // The notify hook is configured in config.toml via mergeConfig
  if (options.verbose) console.log(`  Notify hook: ${hookScript}`);
}

async function verifyTeamCliApiInterop(
  pkgRoot: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const teamCliPath = join(pkgRoot, "dist", "cli", "team.js");
  if (!existsSync(teamCliPath)) {
    return { ok: false, message: `missing ${teamCliPath}` };
  }

  try {
    const content = await readFile(teamCliPath, "utf-8");
    const missing = REQUIRED_TEAM_CLI_API_MARKERS.filter(
      (marker) => !content.includes(marker),
    );
    if (missing.length > 0) {
      return {
        ok: false,
        message: `team CLI interop markers missing: ${missing.join(", ")}`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: `cannot read ${teamCliPath}` };
  }
}
