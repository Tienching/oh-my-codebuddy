/**
 * Rules Injector Hook - Discovers and injects rule files on PostToolUse
 *
 * After file-access tools (Read, Write, Edit, MultiEdit), discovers matching
 * rule files from .omb/rules/, .cursor/rules/, .github/instructions/, etc.
 * and injects their content into the tool output. Deduplicates by real path
 * and content hash to prevent repeated injection.
 *
 */

import { existsSync, readFileSync, realpathSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { join, relative, dirname, basename } from "path";
import { homedir } from "os";

// ── Types ──────────────────────────────────────────────────────────────

export interface RuleMetadata {
  description?: string;
  globs?: string[];
  alwaysApply?: boolean;
}

export interface RuleFileCandidate {
  path: string;
  realPath: string;
  isGlobal: boolean;
  distance: number;
}

export interface RuleToInject {
  relativePath: string;
  matchReason: string;
  content: string;
  distance: number;
}

export interface InjectedRulesData {
  sessionId: string;
  injectedHashes: string[];
  injectedRealPaths: string[];
  updatedAt: number;
}

// ── Constants ──────────────────────────────────────────────────────────

const PROJECT_RULE_SUBDIRS = [
  ".omb/rules",
  ".cursor/rules",
  ".claude/rules",
  ".github/instructions",
];

const SINGLE_FILE_RULES = [
  ".github/copilot-instructions.md",
  ".cursorrules",
  ".claudeinstructions",
];

const TRACKED_TOOLS = new Set(["read", "write", "edit", "multiedit"]);

const RULE_FILE_EXTENSIONS = new Set([".md", ".mdc", ".instructions.md"]);

// ── YAML frontmatter parser ───────────────────────────────────────────

/**
 * Custom YAML frontmatter parser (no external deps).
 * Extracts description, alwaysApply, and globs/paths/applyTo fields.
 */
export function parseFrontmatter(
  content: string,
): { metadata: RuleMetadata; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) {
    return { metadata: {}, body: content };
  }

  const frontmatter = match[1];
  const body = content.slice(match[0].length);
  const metadata: RuleMetadata = {};

  // Parse description
  const descMatch = frontmatter.match(/description:\s*["']?(.+?)["']?\s*$/m);
  if (descMatch) metadata.description = descMatch[1].trim();

  // Parse alwaysApply
  const alwaysMatch = frontmatter.match(/alwaysApply:\s*(true|false)/i);
  if (alwaysMatch) metadata.alwaysApply = alwaysMatch[1].toLowerCase() === "true";

  // Parse globs/paths/applyTo
  const globs: string[] = [];

  // Array format: globs: ["a", "b"]
  const arrayMatch = frontmatter.match(
    /(?:globs|paths|applyTo):\s*\[([^\]]*)\]/,
  );
  if (arrayMatch) {
    const items = arrayMatch[1].match(/["']([^"']+)["']/g);
    if (items) {
      globs.push(
        ...items.map((s) => s.replace(/["']/g, "").trim()),
      );
    }
  }

  // Multi-line format: globs:\n  - "a"\n  - "b"
  if (globs.length === 0) {
    const multilineMatch = frontmatter.match(
      /(?:globs|paths|applyTo):\s*\n((?:\s+-\s+.+\n?)*)/,
    );
    if (multilineMatch) {
      const items = multilineMatch[1].match(/-\s+["']?([^"'\n]+)["']?/g);
      if (items) {
        globs.push(
          ...items.map((s) => s.replace(/^-\s+/, "").replace(/["']/g, "").trim()),
        );
      }
    }
  }

  // Comma-separated format: globs: a, b
  if (globs.length === 0) {
    const commaMatch = frontmatter.match(
      /(?:globs|paths|applyTo):\s*(?!["']?\[)(.+)/,
    );
    if (commaMatch) {
      globs.push(
        ...commaMatch[1].split(",").map((s) => s.trim().replace(/["']/g, "")),
      );
    }
  }

  if (globs.length > 0) metadata.globs = globs;

  return { metadata, body };
}

// ── Glob matching ──────────────────────────────────────────────────────

/** Converts a simple glob pattern to a RegExp. Supports *, **, and ?. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/{{GLOBSTAR}}/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** Checks if a rule should apply to a given file path. */
export function shouldApplyRule(
  rule: RuleMetadata,
  filePath: string,
): { applies: boolean; reason?: string } {
  if (rule.alwaysApply) {
    return { applies: true, reason: "alwaysApply: true" };
  }

  if (!rule.globs || rule.globs.length === 0) {
    return { applies: false };
  }

  for (const pattern of rule.globs) {
    const regex = globToRegex(pattern);
    if (regex.test(filePath) || regex.test(basename(filePath))) {
      return { applies: true, reason: `glob: ${pattern}` };
    }
  }

  return { applies: false };
}

// ── Rule file discovery ────────────────────────────────────────────────

function safeRealpathSync(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Walks up from the file to find the project root. */
function findProjectRoot(startDir: string): string | null {
  const markers = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"];
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Calculates directory distance between two paths. */
function calculateDistance(from: string, to: string): number {
  const fromParts = from.split(/[/\\]/);
  const toParts = to.split(/[/\\]/);
  let common = 0;
  const minLen = Math.min(fromParts.length, toParts.length);
  for (let i = 0; i < minLen; i++) {
    if (fromParts[i] === toParts[i]) common++;
    else break;
  }
  return fromParts.length - common + toParts.length - common;
}

/** Discovers rule files relevant to a given file path. */
export function findRuleFiles(
  filePath: string,
): RuleFileCandidate[] {
  const candidates: RuleFileCandidate[] = [];
  const fileDir = dirname(filePath);
  const projectRoot = findProjectRoot(fileDir);

  if (!projectRoot) return candidates;

  // Search project-level rule directories
  for (const subdir of PROJECT_RULE_SUBDIRS) {
    const ruleDir = join(projectRoot, subdir);
    if (!existsSync(ruleDir)) continue;

    try {
      const { readdirSync } = require("fs");
      const files = readdirSync(ruleDir);
      for (const file of files) {
        const ext = file.substring(file.lastIndexOf("."));
        if (!RULE_FILE_EXTENSIONS.has(ext) && !file.endsWith(".instructions.md"))
          continue;
        const fullPath = join(ruleDir, file);
        const realPath = safeRealpathSync(fullPath);
        const distance = calculateDistance(fileDir, dirname(fullPath));
        candidates.push({
          path: fullPath,
          realPath,
          isGlobal: false,
          distance,
        });
      }
    } catch {
      // Directory may not be readable
    }
  }

  // Check single-file rules at project root
  for (const singleFile of SINGLE_FILE_RULES) {
    const fullPath = join(projectRoot, singleFile);
    if (existsSync(fullPath)) {
      candidates.push({
        path: fullPath,
        realPath: safeRealpathSync(fullPath),
        isGlobal: false,
        distance: calculateDistance(fileDir, projectRoot),
      });
    }
  }

  // Check user-level global rules
  const globalRuleDir = join(homedir(), ".omb", "rules");
  if (existsSync(globalRuleDir)) {
    try {
      const { readdirSync } = require("fs");
      const files = readdirSync(globalRuleDir);
      for (const file of files) {
        const ext = file.substring(file.lastIndexOf("."));
        if (!RULE_FILE_EXTENSIONS.has(ext)) continue;
        const fullPath = join(globalRuleDir, file);
        candidates.push({
          path: fullPath,
          realPath: safeRealpathSync(fullPath),
          isGlobal: true,
          distance: 9999,
        });
      }
    } catch {
      // Ignore
    }
  }

  // Sort by distance (closest first)
  candidates.sort((a, b) => a.distance - b.distance);

  return candidates;
}

// ── Content hashing ────────────────────────────────────────────────────

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ── Session storage ────────────────────────────────────────────────────

function rulesInjectorDir(): string {
  return join(homedir(), ".omb", "rules-injector");
}

async function loadSessionData(
  sessionId: string,
): Promise<InjectedRulesData> {
  const path = join(rulesInjectorDir(), `${sessionId}.json`);
  try {
    if (!existsSync(path)) {
      return {
        sessionId,
        injectedHashes: [],
        injectedRealPaths: [],
        updatedAt: Date.now(),
      };
    }
    return JSON.parse(await readFile(path, "utf-8")) as InjectedRulesData;
  } catch {
    return {
      sessionId,
      injectedHashes: [],
      injectedRealPaths: [],
      updatedAt: Date.now(),
    };
  }
}

async function saveSessionData(data: InjectedRulesData): Promise<void> {
  const dir = rulesInjectorDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${data.sessionId}.json`),
    JSON.stringify({ ...data, updatedAt: Date.now() }, null, 2) + "\n",
  );
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Run the rules injector for a PostToolUse event.
 * Returns a list of rules to inject, or empty array if none match.
 */
export async function runRulesInjector(options: {
  toolName: string;
  filePath: string;
  sessionId: string;
  projectRoot?: string;
}): Promise<RuleToInject[]> {
  const { toolName, filePath, sessionId } = options;

  // Only activate for tracked tools
  if (!TRACKED_TOOLS.has(toolName.toLowerCase())) {
    return [];
  }

  if (!existsSync(filePath)) return [];

  const candidates = findRuleFiles(filePath);
  const sessionData = await loadSessionData(sessionId);
  const rulesToInject: RuleToInject[] = [];

  for (const candidate of candidates) {
    // Dedup by real path
    if (sessionData.injectedRealPaths.includes(candidate.realPath)) continue;

    // Read and parse rule file
    let content: string;
    try {
      content = readFileSync(candidate.path, "utf-8");
    } catch {
      continue;
    }

    const { metadata, body } = parseFrontmatter(content);

    // Check if rule applies to this file
    const match = shouldApplyRule(metadata, filePath);
    if (!match.applies) continue;

    // Dedup by content hash
    const hash = contentHash(body);
    if (sessionData.injectedHashes.includes(hash)) continue;

    const relPath = relative(process.cwd(), candidate.path);
    rulesToInject.push({
      relativePath: relPath || candidate.path,
      matchReason: match.reason ?? "matched",
      content: body.trim(),
      distance: candidate.distance,
    });

    // Update session data
    sessionData.injectedHashes.push(hash);
    sessionData.injectedRealPaths.push(candidate.realPath);
  }

  // Persist session data if any rules were injected
  if (rulesToInject.length > 0) {
    await saveSessionData(sessionData);
  }

  return rulesToInject;
}

/**
 * Format injected rules as text for agent context injection.
 */
export function formatInjectedRules(rules: RuleToInject[]): string {
  if (rules.length === 0) return "";

  return rules
    .map(
      (r) =>
        `[Rule: ${r.relativePath}]\n[Match: ${r.matchReason}]\n${r.content}`,
    )
    .join("\n\n---\n\n");
}
