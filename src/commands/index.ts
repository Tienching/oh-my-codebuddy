import { existsSync, realpathSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseCommandFile } from "./parser.js";

export const OMB_EXPERIMENTAL_COMMAND_TEMPLATES =
  "OMB_EXPERIMENTAL_COMMAND_TEMPLATES";
export const COMMAND_TEMPLATE_DISALLOWED_ENV_VALUES = new Set(["0", "false", "no", "off"]);
export const COMMAND_TEMPLATE_PLACEHOLDER = "$ARGUMENTS";

export interface CommandTemplateInfo {
  name: string;
  description: string;
  template: string;
  path: string;
}

export interface CommandTemplateOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const SUPPORTED_COMMAND_EXTS = [".md", ".txt", ""] as const;
const COMMAND_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const COMMAND_TEMPLATE_SETUP_PROVIDERS = new Set(["codebuddy", "codex", "both"]);
type CommandTemplateSetupProvider = "codebuddy" | "codex" | "both";

function resolveCodeBuddyHome(env: NodeJS.ProcessEnv): string {
  const envHome = env.CODEBUDDY_HOME;
  if (typeof envHome === "string" && envHome.trim() !== "") {
    return envHome.trim();
  }
  return join(homedir(), ".codebuddy");
}

function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  const envHome = env.CODEX_HOME;
  if (typeof envHome === "string" && envHome.trim() !== "") {
    return envHome.trim();
  }
  return join(homedir(), ".codex");
}

function resolveCommandTemplateSetupProvider(
  cwd: string,
): CommandTemplateSetupProvider {
  const setupScopePath = join(cwd, ".omb", "setup-scope.json");
  if (existsSync(setupScopePath)) {
    try {
      const parsed = JSON.parse(readFileSync(setupScopePath, "utf-8")) as Partial<{
        provider: string;
      }>;
      const rawProvider = parsed.provider ?? "";
      const provider = String(rawProvider).trim().toLowerCase();
      if (COMMAND_TEMPLATE_SETUP_PROVIDERS.has(provider)) {
        return provider as CommandTemplateSetupProvider;
      }
      // Unknown provider in an otherwise readable scope file. Warn so a
      // corrupted/hand-edited scope doesn't silently collapse to CodeBuddy,
      // but fall back rather than fail-closed so the user can still recover.
      process.stderr.write(
        `[omb] warning: ignoring unknown provider "${String(rawProvider)}" in ${setupScopePath}; falling back to codebuddy. Run \`omb setup\` to repair.\n`,
      );
    } catch {
      // Ignore malformed scope and fall back to CodeBuddy provider.
      process.stderr.write(
        `[omb] warning: could not parse ${setupScopePath}; falling back to codebuddy provider. Run \`omb setup\` to repair.\n`,
      );
    }
  }

  return "codebuddy";
}

function sanitizeCommandName(name: string): string | null {
  const trimmed = name.trim();
  if (!COMMAND_NAME_RE.test(trimmed)) return null;
  return trimmed;
}

function normalizeEnvValue(raw: string | undefined): boolean | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (COMMAND_TEMPLATE_DISALLOWED_ENV_VALUES.has(normalized)) return false;
  return true;
}

function dedupePreserve<T>(values: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const value of values) {
    const key = String(value).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function addCommandTemplateDirectory(paths: string[], path: string): void {
  paths.push(path);
}

function resolveCommandTemplateDirectories(
  cwd: string,
  env: NodeJS.ProcessEnv,
  provider: CommandTemplateSetupProvider,
): string[] {
  const paths: string[] = [];

  // Order is intentional: project scope wins over user scope, and within each
  // scope the primary provider (CodeBuddy) wins over the secondary (Codex).
  // `provider=both` therefore resolves as:
  //   1. project .codebuddy/commands
  //   2. project .codex/commands
  //   3. user CODEBUDDY_HOME/commands
  //   4. user CODEX_HOME/commands
  // so a per-project Codex override is never shadowed by an ambient user-level
  // CodeBuddy install.
  if (provider === "both" || provider === "codebuddy") {
    addCommandTemplateDirectory(paths, join(cwd, ".codebuddy", "commands"));
  }

  if (provider === "both" || provider === "codex") {
    addCommandTemplateDirectory(paths, join(cwd, ".codex", "commands"));
  }

  if (provider === "both" || provider === "codebuddy") {
    addCommandTemplateDirectory(paths, join(resolveCodeBuddyHome(env), "commands"));
  }

  if (provider === "both" || provider === "codex") {
    addCommandTemplateDirectory(paths, join(resolveCodexHome(env), "commands"));
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of paths) {
    const normalized = canonicalPath(item);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(item);
  }

  return deduped.filter((path) => existsSync(path));
}

export function isCommandTemplateEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const codeBuddyValue = normalizeEnvValue(env[OMB_EXPERIMENTAL_COMMAND_TEMPLATES]);
  if (codeBuddyValue !== null) {
    return codeBuddyValue;
  }
  const omniValue = normalizeEnvValue(env[OMB_EXPERIMENTAL_COMMAND_TEMPLATES]);
  if (omniValue !== null) {
    return omniValue;
  }
  return false;
}

function deriveCommandCandidates(name: string): string[] {
  return SUPPORTED_COMMAND_EXTS.map((ext) => `${name}${ext}`);
}

function inferCommandName(fileName: string): string | null {
  if (fileName.startsWith(".")) return null;
  const ext = fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf("."))
    : "";
  if (ext && !SUPPORTED_COMMAND_EXTS.includes(ext as typeof SUPPORTED_COMMAND_EXTS[number])) {
    return null;
  }
  const name = ext ? fileName.slice(0, -ext.length) : fileName;
  if (name.trim() === "") return null;
  return sanitizeCommandName(name);
}

export async function getCommandInfo(
  commandName: string,
  options: CommandTemplateOptions = {},
): Promise<CommandTemplateInfo | undefined> {
  const name = sanitizeCommandName(commandName);
  if (!name) return undefined;

  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const provider = resolveCommandTemplateSetupProvider(cwd);
  const commandDirs = resolveCommandTemplateDirectories(cwd, env, provider);
  const candidates = deriveCommandCandidates(name);

  for (const dir of commandDirs) {
    for (const fileName of candidates) {
      const commandPath = join(dir, fileName);
      if (!existsSync(commandPath)) continue;

      try {
        const content = await readFile(commandPath, "utf-8");
        const parsed = parseCommandFile(content);
        return {
          name,
          description: parsed.description,
          template: parsed.template,
          path: commandPath,
        };
      } catch {
        continue;
      }
    }
  }

  return undefined;
}

export async function listCommandNames(
  options: CommandTemplateOptions = {},
): Promise<string[]> {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const provider = resolveCommandTemplateSetupProvider(cwd);
  const commandDirs = resolveCommandTemplateDirectories(cwd, env, provider);
  const names: string[] = [];

  for (const dir of commandDirs) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true }).then((items) =>
        items
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort((a, b) => a.localeCompare(b)),
      );
    } catch {
      continue;
    }

    for (const fileName of entries) {
      const name = inferCommandName(fileName);
      if (!name) continue;
      names.push(name);
    }
  }

  return dedupePreserve(names);
}

export async function expandCommandPrompt(
  commandName: string,
  args: string[],
  options: CommandTemplateOptions = {},
): Promise<string | undefined> {
  if (!isCommandTemplateEnabled(options.env)) {
    return undefined;
  }

  const info = await getCommandInfo(commandName, options);
  if (!info) return undefined;

  const replacement = args.join(" ").trim();
  const expanded = info.template.includes(COMMAND_TEMPLATE_PLACEHOLDER)
    ? info.template.replaceAll(COMMAND_TEMPLATE_PLACEHOLDER, replacement)
    : info.template;
  const prompt = expanded.trim();
  if (prompt.length === 0) return undefined;
  return prompt;
}
