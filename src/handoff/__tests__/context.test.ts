import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { collectHandoffContext } from "../context.js";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("collectHandoffContext", () => {
  it("returns warnings but does not throw outside git repos", async () => {
    await withTempDir("omb-handoff-context-nogit-", async (cwd) => {
      const context = await collectHandoffContext(cwd);
      assert.equal(context.cwd, cwd);
      assert.equal(context.project_name, basename(cwd));
      assert.deepEqual(context.changed_files, []);
      assert.ok(context.warnings.some((warning) => /git branch unavailable/i.test(warning)));
    });
  });

  it("includes git status changed files and bounded diff summary", async () => {
    await withTempDir("omb-handoff-context-git-", async (cwd) => {
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "changed.txt"), "hello\n");
      const context = await collectHandoffContext(cwd);
      assert.match(context.git_status ?? "", /changed\.txt/);
      assert.ok(context.changed_files.includes("changed.txt"));
      assert.ok((context.diff_summary ?? "").length <= 12000);
    });
  });

  it("includes session state and plan filenames when present", async () => {
    await withTempDir("omb-handoff-context-state-", async (cwd) => {
      await mkdir(join(cwd, ".omb", "state"), { recursive: true });
      await mkdir(join(cwd, ".omb", "plans"), { recursive: true });
      await writeFile(join(cwd, ".omb", "state", "session.json"), JSON.stringify({ session_id: "s1" }));
      await writeFile(join(cwd, ".omb", "state", "autopilot.json"), JSON.stringify({ active: true }));
      await writeFile(join(cwd, ".omb", "plans", "prd-test.md"), "# Plan\n");
      const context = await collectHandoffContext(cwd);
      assert.deepEqual(context.session, { session_id: "s1" });
      assert.ok(context.active_modes.includes("autopilot"));
      assert.deepEqual(context.plan_files, ["prd-test.md"]);
    });
  });
});
