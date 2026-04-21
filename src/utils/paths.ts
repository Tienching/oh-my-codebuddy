/**
 * Path utilities for oh-my-codebuddy.
 * Resolves CodeBuddy/Codex config, skills, prompts, and state directories
 * while preserving legacy Codex + OMX compatibility where required.
 */

import { createHash } from "crypto";
import { existsSync, realpathSync } from "fs";
import { readdir, readFile, realpath } from "fs/promises";
import { dirname, isAbsolute, join, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

/** Legacy Codex CLI home directory (~/.codex/) */
export function codexHome(): string {
  return process.env.CODEX_HOME || process.env.CODEBUDDY_HOME || join(homedir(), ".codex");
}

export const OMX_ENTRY_PATH_ENV = "OMX_ENTRY_PATH";
export const OMB_ENTRY_PATH_ENV = "OMB_ENTRY_PATH";
export const OMX_STARTUP_CWD_ENV = "OMX_STARTUP_CWD";

function resolveLauncherPath(rawPath: string, baseCwd: string): string {
  const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(baseCwd, rawPath);
  if (!existsSync(absolutePath)) return absolutePath;
  try {
    return typeof realpathSync.native === "function"
      ? realpathSync.native(absolutePath)
      : realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

export function resolveOmxEntryPath(
  options: {
    argv1?: string | null;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string | null {
  const { argv1 = process.argv[1], cwd = process.cwd(), env = process.env } = options;
  const fromEnv = String(env[OMX_ENTRY_PATH_ENV] ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  const fromOmbEnv = String(env[OMB_ENTRY_PATH_ENV] ?? "").trim();
  if (fromOmbEnv !== "") return fromOmbEnv;

  const rawPath = typeof argv1 === "string" ? argv1.trim() : "";
  if (rawPath === "") return null;

  const startupCwd = String(env[OMX_STARTUP_CWD_ENV] ?? "").trim() || cwd;
  return resolveLauncherPath(rawPath, startupCwd);
}

function isCliEntryPath(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/\\/g, "/");
  return (
    normalized.endsWith('/dist/cli/omx.js') ||
    normalized.endsWith('/omx.js') ||
    normalized.endsWith('/dist/cli/omb.js') ||
    normalized.endsWith('/omb.js')
  );
}

export function resolveOmxCliEntryPath(
  options: {
    argv1?: string | null;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    packageRootDir?: string;
  } = {},
): string | null {
  const entry = resolveOmxEntryPath(options);
  if (isCliEntryPath(entry)) return entry;

  const packageRootDir = options.packageRootDir || packageRoot();
  const omxFallback = resolveLauncherPath(join(packageRootDir, 'dist', 'cli', 'omx.js'), options.cwd || process.cwd());
  if (existsSync(omxFallback)) return omxFallback;
  const ombFallback = resolveLauncherPath(join(packageRootDir, 'dist', 'cli', 'omb.js'), options.cwd || process.cwd());
  if (existsSync(ombFallback)) return ombFallback;
  return entry;
}

export function rememberOmxLaunchContext(
  options: {
    argv1?: string | null;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): void {
  const { cwd = process.cwd(), env = process.env } = options;
  if (String(env[OMX_STARTUP_CWD_ENV] ?? "").trim() === "") {
    env[OMX_STARTUP_CWD_ENV] = cwd;
  }
  if (String(env[OMX_ENTRY_PATH_ENV] ?? "").trim() !== "") return;

  const resolved = resolveOmxEntryPath({
    argv1: options.argv1,
    cwd,
    env,
  });
  if (resolved) {
    env[OMX_ENTRY_PATH_ENV] = resolved;
  }
}

/** Codex config file path (~/.codex/config.toml) */
export function codexConfigPath(): string {
  return join(codexHome(), "config.toml");
}

/** Codex prompts directory (~/.codex/prompts/) */
export function codexPromptsDir(): string {
  return join(codexHome(), "prompts");
}

/** Codex native agents directory (~/.codex/agents/) */
export function codexAgentsDir(codexHomeDir?: string): string {
  return join(codexHomeDir || codexHome(), "agents");
}

/** Project-level Codex native agents directory (.codex/agents/) */
export function projectCodexAgentsDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".codex", "agents");
}

/** User-level skills directory ($CODEBUDDY_HOME/skills, with $CODEX_HOME as fallback) */
export function userSkillsDir(): string {
  return join(codebuddyHome(), "skills");
}

/** Project-level skills directory (.codebuddy/skills/) */
export function projectSkillsDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".codebuddy", "skills");
}

/** Historical legacy user-level skills directory (~/.agents/skills/) */
export function legacyUserSkillsDir(): string {
  return join(homedir(), ".agents", "skills");
}

// ── Brand-migrated aliases (codex→codebuddy, omx→omb) ─────────────────────────────────

/** CodeBuddy CLI home directory (~/.codebuddy/, with $CODEX_HOME compatibility fallback) */
export function codebuddyHome(): string {
  return process.env.CODEBUDDY_HOME || process.env.CODEX_HOME || join(homedir(), ".codebuddy");
}

/** CodeBuddy config file path (~/.codebuddy/config.toml) */
export function codebuddyConfigPath(): string {
  return join(codebuddyHome(), "config.toml");
}

/** CodeBuddy prompts directory (~/.codebuddy/prompts/) */
export function codebuddyPromptsDir(): string {
  return join(codebuddyHome(), "prompts");
}

/** CodeBuddy native agents directory (~/.codebuddy/agents/) */
export function codebuddyAgentsDir(codebuddyHomeDir?: string): string {
  return join(codebuddyHomeDir || codebuddyHome(), "agents");
}

/** Project-level CodeBuddy native agents directory (.codebuddy/agents/) */
export function projectCodebuddyAgentsDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".codebuddy", "agents");
}

/** oh-my-codebuddy state directory (.omb/state/) */
export function ombStateDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omb", "state");
}

/** oh-my-codebuddy project memory file (.omb/project-memory.json) */
export function ombProjectMemoryPath(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omb", "project-memory.json");
}

/** oh-my-codebuddy notepad file (.omb/notepad.md) */
export function ombNotepadPath(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omb", "notepad.md");
}

/** oh-my-codebuddy plans directory (.omb/plans/) */
export function ombPlansDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omb", "plans");
}

/** oh-my-codebuddy logs directory (.omb/logs/) */
export function ombLogsDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omb", "logs");
}

export type InstalledSkillScope = "project" | "user";

export interface InstalledSkillDirectory {
  name: string;
  path: string;
  scope: InstalledSkillScope;
}

export interface SkillRootOverlapReport {
  canonicalDir: string;
  legacyDir: string;
  canonicalExists: boolean;
  legacyExists: boolean;
  canonicalResolvedDir: string | null;
  legacyResolvedDir: string | null;
  sameResolvedTarget: boolean;
  canonicalSkillCount: number;
  legacySkillCount: number;
  overlappingSkillNames: string[];
  mismatchedSkillNames: string[];
}

async function readInstalledSkillsFromDir(
  dir: string,
  scope: InstalledSkillScope,
): Promise<InstalledSkillDirectory[]> {
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(dir, entry.name),
      scope,
    }))
    .filter((entry) => existsSync(join(entry.path, "SKILL.md")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Installed skill directories in scope-precedence order.
 * Project skills win over user-level skills with the same directory basename.
 */
export async function listInstalledSkillDirectories(
  projectRoot?: string,
): Promise<InstalledSkillDirectory[]> {
  const orderedDirs: Array<{ dir: string; scope: InstalledSkillScope }> = [
    { dir: projectSkillsDir(projectRoot), scope: "project" },
    { dir: userSkillsDir(), scope: "user" },
  ];

  const deduped: InstalledSkillDirectory[] = [];
  const seenNames = new Set<string>();

  for (const { dir, scope } of orderedDirs) {
    const skills = await readInstalledSkillsFromDir(dir, scope);
    for (const skill of skills) {
      if (seenNames.has(skill.name)) continue;
      seenNames.add(skill.name);
      deduped.push(skill);
    }
  }

  return deduped;
}

export async function detectLegacySkillRootOverlap(
  canonicalDir = userSkillsDir(),
  legacyDir = legacyUserSkillsDir(),
): Promise<SkillRootOverlapReport> {
  const canonicalExists = existsSync(canonicalDir);
  const legacyExists = existsSync(legacyDir);
  const [canonicalSkills, legacySkills, canonicalResolvedDir, legacyResolvedDir] = await Promise.all([
    readInstalledSkillsFromDir(canonicalDir, "user"),
    readInstalledSkillsFromDir(legacyDir, "user"),
    canonicalExists ? realpath(canonicalDir).catch(() => null) : Promise.resolve(null),
    legacyExists ? realpath(legacyDir).catch(() => null) : Promise.resolve(null),
  ]);

  const canonicalHashes = await hashSkillDirectory(canonicalSkills);
  const legacyHashes = await hashSkillDirectory(legacySkills);
  const canonicalNames = new Set(canonicalSkills.map((skill) => skill.name));
  const legacyNames = new Set(legacySkills.map((skill) => skill.name));
  const overlappingSkillNames = [...canonicalNames]
    .filter((name) => legacyNames.has(name))
    .sort((a, b) => a.localeCompare(b));
  const mismatchedSkillNames = overlappingSkillNames.filter(
    (name) => canonicalHashes.get(name) !== legacyHashes.get(name),
  );
  const sameResolvedTarget =
    canonicalResolvedDir !== null &&
    legacyResolvedDir !== null &&
    canonicalResolvedDir === legacyResolvedDir;

  return {
    canonicalDir,
    legacyDir,
    canonicalExists,
    legacyExists,
    canonicalResolvedDir,
    legacyResolvedDir,
    sameResolvedTarget,
    canonicalSkillCount: canonicalSkills.length,
    legacySkillCount: legacySkills.length,
    overlappingSkillNames,
    mismatchedSkillNames,
  };
}

async function hashSkillDirectory(
  skills: InstalledSkillDirectory[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  for (const skill of skills) {
    try {
      const content = await readFile(join(skill.path, "SKILL.md"), "utf-8");
      hashes.set(skill.name, createHash("sha256").update(content).digest("hex"));
    } catch {
      // Ignore unreadable SKILL.md files; existence is enough for overlap detection.
    }
  }

  return hashes;
}

/** OMB compatibility state directory (.omx/state/) */
export function omxStateDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omx", "state");
}

/** OMB compatibility project memory file (.omx/project-memory.json) */
export function omxProjectMemoryPath(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omx", "project-memory.json");
}

/** OMB compatibility notepad file (.omx/notepad.md) */
export function omxNotepadPath(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omx", "notepad.md");
}

/** OMB compatibility plans directory (.omx/plans/) */
export function omxPlansDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omx", "plans");
}

/** OMB compatibility logs directory (.omx/logs/) */
export function omxLogsDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omx", "logs");
}

/** Get the package root directory (where agents/, skills/, prompts/ live) */
export function packageRoot(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const candidate = join(__dirname, "..", "..");
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    const candidate2 = join(__dirname, "..");
    if (existsSync(join(candidate2, "package.json"))) {
      return candidate2;
    }
  } catch {
    // fall through to cwd fallback
  }
  return process.cwd();
}
