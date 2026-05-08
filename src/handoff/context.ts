import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COMMAND_OUTPUT_LIMIT = 12000;
const PLAN_FILE_LIMIT = 25;

export interface HandoffContext {
  cwd: string;
  project_name: string;
  branch?: string;
  git_status?: string;
  changed_files: string[];
  diff_summary?: string;
  session?: Record<string, unknown>;
  active_modes: string[];
  plan_files: string[];
  warnings: string[];
}

function bounded(text: string, warnings: string[], label: string): string {
  if (text.length <= COMMAND_OUTPUT_LIMIT) return text;
  warnings.push(`${label} output truncated to ${COMMAND_OUTPUT_LIMIT} characters`);
  return `${text.slice(0, COMMAND_OUTPUT_LIMIT)}\n...[truncated]`;
}

async function runGit(cwd: string, args: string[], warnings: string[], label: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: COMMAND_OUTPUT_LIMIT * 2,
      timeout: 5000,
    });
    return bounded(String(result.stdout ?? "").trim(), warnings, label);
  } catch (error) {
    warnings.push(`${label} unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return undefined;
  }
}

function parseChangedFiles(status: string | undefined): string[] {
  if (!status) return [];
  const files: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("##")) continue;
    const raw = line.length > 3 ? line.slice(3).trim() : line.trim();
    if (!raw) continue;
    const file = raw.includes(" -> ") ? raw.split(" -> ").pop() ?? raw : raw;
    files.push(file.replace(/^"|"$/g, ""));
  }
  return [...new Set(files)].slice(0, 200);
}

async function readJsonObject(path: string, warnings: string[], label: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    warnings.push(`${label} is not a JSON object`);
  } catch (error) {
    warnings.push(`Could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectActiveModes(cwd: string): Promise<string[]> {
  const stateDir = join(cwd, ".omb", "state");
  const candidates: Array<[string, string[]]> = [
    ["autopilot", [join(stateDir, "autopilot.json"), join(stateDir, "autopilot-state.json")]],
    ["ralph", [join(stateDir, "ralph"), join(stateDir, "ralph.json"), join(stateDir, "ralph-state.json")]],
    ["team", [join(stateDir, "team"), join(stateDir, "team.json"), join(stateDir, "team-state.json")]],
  ];
  const active: string[] = [];
  for (const [mode, paths] of candidates) {
    for (const path of paths) {
      if (await pathExists(path)) {
        active.push(mode);
        break;
      }
    }
  }
  return active;
}

async function collectPlanFiles(cwd: string, warnings: string[]): Promise<string[]> {
  const plansDir = join(cwd, ".omb", "plans");
  if (!existsSync(plansDir)) return [];
  try {
    const entries = await readdir(plansDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(md|json)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, PLAN_FILE_LIMIT);
  } catch (error) {
    warnings.push(`Could not read .omb plans: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export async function collectHandoffContext(cwd: string): Promise<HandoffContext> {
  const resolvedCwd = resolve(cwd);
  const warnings: string[] = [];
  const branch = await runGit(resolvedCwd, ["rev-parse", "--abbrev-ref", "HEAD"], warnings, "git branch");
  const gitStatus = await runGit(resolvedCwd, ["status", "--short", "--branch"], warnings, "git status");
  const diffSummary = await runGit(resolvedCwd, ["diff", "--stat"], warnings, "git diff summary");
  const session = await readJsonObject(join(resolvedCwd, ".omb", "state", "session.json"), warnings, ".omb/state/session.json");

  return {
    cwd: resolvedCwd,
    project_name: basename(resolvedCwd),
    branch: branch || undefined,
    git_status: gitStatus || undefined,
    changed_files: parseChangedFiles(gitStatus),
    diff_summary: diffSummary || undefined,
    session,
    active_modes: await collectActiveModes(resolvedCwd),
    plan_files: await collectPlanFiles(resolvedCwd, warnings),
    warnings,
  };
}
