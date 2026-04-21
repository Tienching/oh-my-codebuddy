/**
 * Pre-Compact Hook - Preserves state before context compaction
 *
 * Fires before CodeBuddy compacts its context window. Snapshots active mode
 * states, TODO counts, and plan wisdom so the agent retains awareness after
 * compaction. Writes a checkpoint to .omb/state/checkpoints/ and returns a
 * system message injected into the post-compaction context.
 *
 */

import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

// ── Types ──────────────────────────────────────────────────────────────

export interface ActiveModeSnapshot {
  autopilot?: { phase: string; originalIdea: string };
  ralph?: { iteration: number; prompt: string };
  ultrawork?: { original_prompt: string };
  ultraqa?: { cycle: number; prompt: string };
  team?: { phase: string; teamName: string };
  ralplan?: { phase: string };
}

export interface TodoSummary {
  pending: number;
  in_progress: number;
  completed: number;
}

export interface CompactCheckpoint {
  created_at: string;
  trigger: "manual" | "auto";
  active_modes: ActiveModeSnapshot;
  todo_summary: TodoSummary;
  wisdom_exported: boolean;
  session_id?: string;
}

export interface PreCompactInput {
  session_id?: string;
  cwd: string;
  trigger?: "manual" | "auto";
}

export interface PreCompactOutput {
  checkpoint: CompactCheckpoint;
  systemMessage: string;
}

// ── State paths ────────────────────────────────────────────────────────

function ombStateDir(cwd: string): string {
  return join(cwd, ".omb", "state");
}

function checkpointsDir(cwd: string): string {
  return join(ombStateDir(cwd), "checkpoints");
}

// ── Mode state readers ─────────────────────────────────────────────────

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    if (!existsSync(path)) return null;
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readActiveModes(stateDir: string): Promise<ActiveModeSnapshot> {
  const modes: ActiveModeSnapshot = {};

  const autopilot = await readJsonFile<{
    phase?: string;
    originalIdea?: string;
  }>(join(stateDir, "autopilot-state.json"));
  if (autopilot?.phase) {
    modes.autopilot = {
      phase: autopilot.phase,
      originalIdea: autopilot.originalIdea ?? "",
    };
  }

  const ralph = await readJsonFile<{
    iteration?: number;
    prompt?: string;
    active?: boolean;
  }>(join(stateDir, "ralph-state.json"));
  if (ralph?.active) {
    modes.ralph = {
      iteration: ralph.iteration ?? 0,
      prompt: ralph.prompt ?? "",
    };
  }

  const ultrawork = await readJsonFile<{
    original_prompt?: string;
    active?: boolean;
  }>(join(stateDir, "ultrawork-state.json"));
  if (ultrawork?.active) {
    modes.ultrawork = { original_prompt: ultrawork.original_prompt ?? "" };
  }

  const ultraqa = await readJsonFile<{
    cycle?: number;
    prompt?: string;
    active?: boolean;
  }>(join(stateDir, "ultraqa-state.json"));
  if (ultraqa?.active) {
    modes.ultraqa = { cycle: ultraqa.cycle ?? 0, prompt: ultraqa.prompt ?? "" };
  }

  const team = await readJsonFile<{
    phase?: string;
    teamName?: string;
    active?: boolean;
  }>(join(stateDir, "team-state.json"));
  if (team?.active) {
    modes.team = { phase: team.phase ?? "", teamName: team.teamName ?? "" };
  }

  const ralplan = await readJsonFile<{ phase?: string; active?: boolean }>(
    join(stateDir, "ralplan-state.json"),
  );
  if (ralplan?.active) {
    modes.ralplan = { phase: ralplan.phase ?? "" };
  }

  return modes;
}

async function readTodoSummary(stateDir: string): Promise<TodoSummary> {
  const todos = await readJsonFile<
    Array<{ status?: string }>
  >(join(stateDir, "todos.json"));

  if (!todos || !Array.isArray(todos)) {
    return { pending: 0, in_progress: 0, completed: 0 };
  }

  let pending = 0;
  let in_progress = 0;
  let completed = 0;

  for (const todo of todos) {
    const status = todo.status ?? "pending";
    if (status === "completed") completed++;
    else if (status === "in_progress") in_progress++;
    else pending++;
  }

  return { pending, in_progress, completed };
}

async function exportWisdom(
  cwd: string,
): Promise<{ exported: boolean; content: string }> {
  const notepadsDir = join(cwd, ".omb", "notepads");
  if (!existsSync(notepadsDir)) return { exported: false, content: "" };

  const wisdomFiles = [
    "learnings.md",
    "decisions.md",
    "issues.md",
    "problems.md",
  ];
  const parts: string[] = [];

  try {
    const { readdir } = await import("fs/promises");
    const planDirs = await readdir(notepadsDir);

    for (const planDir of planDirs) {
      for (const wf of wisdomFiles) {
        const path = join(notepadsDir, planDir, wf);
        if (existsSync(path)) {
          const content = await readFile(path, "utf-8");
          if (content.trim()) {
            parts.push(`## ${planDir}/${wf}\n${content.trim()}\n`);
          }
        }
      }
    }
  } catch {
    // Notepads directory may not exist or be readable
  }

  return {
    exported: parts.length > 0,
    content: parts.join("\n---\n\n"),
  };
}

// ── Checkpoint formatting ──────────────────────────────────────────────

function formatCompactSummary(checkpoint: CompactCheckpoint): string {
  const lines: string[] = [
    "[OMB Pre-Compact Checkpoint]",
    `Time: ${checkpoint.created_at}`,
    `Trigger: ${checkpoint.trigger}`,
  ];

  const modes = checkpoint.active_modes;
  const activeModeNames = Object.keys(modes);
  if (activeModeNames.length > 0) {
    lines.push(`Active modes: ${activeModeNames.join(", ")}`);
    if (modes.ralph) {
      lines.push(
        `  Ralph: iteration ${modes.ralph.iteration}, prompt: "${modes.ralph.prompt.slice(0, 80)}${modes.ralph.prompt.length > 80 ? "..." : ""}"`,
      );
    }
    if (modes.autopilot) {
      lines.push(`  Autopilot: phase ${modes.autopilot.phase}`);
    }
    if (modes.team) {
      lines.push(`  Team: phase ${modes.team.phase} (${modes.team.teamName})`);
    }
    if (modes.ultrawork) {
      lines.push(`  Ultrawork: active`);
    }
    if (modes.ralplan) {
      lines.push(`  Ralplan: phase ${modes.ralplan.phase}`);
    }
  } else {
    lines.push("Active modes: none");
  }

  const todo = checkpoint.todo_summary;
  if (todo.pending + todo.in_progress > 0) {
    lines.push(
      `TODOs: ${todo.in_progress} in progress, ${todo.pending} pending, ${todo.completed} completed`,
    );
  }

  if (checkpoint.wisdom_exported) {
    lines.push("Plan wisdom: exported to checkpoint");
  }

  lines.push(
    "\nResume your work. The above state was preserved from before context compaction.",
  );

  return lines.join("\n");
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Run the pre-compact hook: snapshot state, write checkpoint, return
 * a system message for injection into the post-compaction context.
 */
export async function runPreCompact(
  input: PreCompactInput,
): Promise<PreCompactOutput> {
  const { cwd, trigger = "auto" } = input;
  const stateDir = ombStateDir(cwd);

  // Read all state in parallel
  const [activeModes, todoSummary, wisdom] = await Promise.all([
    readActiveModes(stateDir),
    readTodoSummary(stateDir),
    exportWisdom(cwd),
  ]);

  const checkpoint: CompactCheckpoint = {
    created_at: new Date().toISOString(),
    trigger,
    active_modes: activeModes,
    todo_summary: todoSummary,
    wisdom_exported: wisdom.exported,
    session_id: input.session_id,
  };

  // Persist checkpoint
  const cpDir = checkpointsDir(cwd);
  await mkdir(cpDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const checkpointPath = join(cpDir, `checkpoint-${timestamp}.json`);
  await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2) + "\n");

  // Persist wisdom separately if available
  if (wisdom.exported && wisdom.content) {
    const wisdomPath = join(cpDir, `wisdom-${timestamp}.md`);
    await writeFile(wisdomPath, wisdom.content + "\n");
  }

  const systemMessage = formatCompactSummary(checkpoint);

  return { checkpoint, systemMessage };
}
