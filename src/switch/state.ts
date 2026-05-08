import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeAtomicFile } from "../shared/io/atomic-write.js";
import type { LeaderCli } from "../cli/runtime/launch-pipeline.js";

export interface LeaderSwitchState {
  active_leader?: LeaderCli | "unknown";
  target_leader: LeaderCli;
  handoff_id: string;
  handoff_in_progress: boolean;
  handoff_phase?: "prepared" | "launched" | "accepted";
  created_at: string;
  old_session_id?: string;
  new_session_id?: string;
  new_session_name?: string;
  old_window_target?: string;
  new_window_target?: string;
  same_tmux_session?: boolean;
  takeover_prompt_path?: string;
  launch_command?: string;
  launched_at?: string;
}

export function resolveLeaderSwitchStatePath(cwd: string): string {
  return join(resolve(cwd), ".omb", "state", "leader-lock.json");
}

function isLeaderSwitchState(value: unknown): value is LeaderSwitchState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LeaderSwitchState>;
  return typeof candidate.target_leader === "string"
    && typeof candidate.handoff_id === "string"
    && typeof candidate.handoff_in_progress === "boolean"
    && typeof candidate.created_at === "string";
}

export function readLeaderSwitchState(cwd: string, warnings: string[] = []): LeaderSwitchState | undefined {
  const path = resolveLeaderSwitchStatePath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (isLeaderSwitchState(parsed)) return parsed;
    warnings.push(`Leader switch state has invalid shape: ${path}`);
  } catch (error) {
    warnings.push(`Could not read leader switch state: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}

export async function writeLeaderSwitchState(cwd: string, state: LeaderSwitchState): Promise<void> {
  const path = resolveLeaderSwitchStatePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeAtomicFile(path, JSON.stringify(state, null, 2));
}
