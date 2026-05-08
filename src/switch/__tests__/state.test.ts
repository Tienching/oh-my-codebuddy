import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readLeaderSwitchState, resolveLeaderSwitchStatePath, writeLeaderSwitchState } from "../state.js";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("leader switch state", () => {
  it("writes and reads state under .omb/state/leader-lock.json", async () => {
    await withTempDir("omb-switch-state-", async (cwd) => {
      await writeLeaderSwitchState(cwd, {
        target_leader: "claude",
        handoff_id: "handoff-1",
        handoff_in_progress: true,
        handoff_phase: "launched",
        created_at: "2026-05-06T00:00:00.000Z",
        old_session_id: "old-session",
        new_session_id: "new-session",
        new_session_name: "omb-new-session",
      });
      assert.equal(resolveLeaderSwitchStatePath(cwd), join(cwd, ".omb", "state", "leader-lock.json"));
      const state = readLeaderSwitchState(cwd);
      assert.equal(state?.target_leader, "claude");
      assert.equal(state?.handoff_phase, "launched");
      assert.equal(state?.old_session_id, "old-session");
      assert.equal(state?.new_session_id, "new-session");
      assert.equal(state?.new_session_name, "omb-new-session");
    });
  });

  it("malformed state is handled with a warning", async () => {
    await withTempDir("omb-switch-state-bad-", async (cwd) => {
      const path = resolveLeaderSwitchStatePath(cwd);
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(cwd, ".omb", "state"), { recursive: true }));
      await writeFile(path, "not json", "utf-8");
      const warnings: string[] = [];
      assert.equal(readLeaderSwitchState(cwd, warnings), undefined);
      assert.match(warnings.join("\n"), /Could not read leader switch state/);
    });
  });
});
