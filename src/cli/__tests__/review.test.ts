import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { commandOwnsLocalHelp, resolveCliInvocation } from "../index.js";

function runOmb(cwd: string, argv: string[]) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, "..", "..", "..");
  const ombBin = join(repoRoot, "dist", "cli", "omb.js");
  return spawnSync(process.execPath, [ombBin, ...argv], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, HOME: join(cwd, "home"), XDG_CONFIG_HOME: join(cwd, "xdg"), OMB_AUTO_UPDATE: "0", OMB_NOTIFY_FALLBACK: "0", OMB_HOOK_DERIVED_SIGNALS: "0" },
  });
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("omb review", () => {
  it("is a first-class local-help command", () => {
    assert.deepEqual(resolveCliInvocation(["review", "--handoff", "latest"]), { command: "review", launchArgs: [] });
    assert.equal(commandOwnsLocalHelp("review"), true);
  });

  it("reviews latest handoff in human-readable and JSON form", async () => {
    await withTempDir("omb-review-cli-", async (cwd) => {
      assert.equal(runOmb(cwd, ["handoff", "--to", "claude", "--task", "continue work"]).status, 0);
      const human = runOmb(cwd, ["review", "--handoff", "latest"]);
      assert.equal(human.status, 0, human.stderr || human.stdout);
      assert.match(human.stdout, /Verdict: approve/);
      assert.match(human.stdout, /verification evidence/i);

      const json = runOmb(cwd, ["review", "--handoff", "latest", "--json"]);
      assert.equal(json.status, 0, json.stderr || json.stdout);
      const parsed = JSON.parse(json.stdout);
      assert.equal(parsed.verdict, "approve");
      assert.equal(parsed.handoff.to_provider, "claude");
    });
  });

  it("returns actionable error when latest handoff is missing", async () => {
    await withTempDir("omb-review-cli-missing-", async (cwd) => {
      const res = runOmb(cwd, ["review"]);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /No latest handoff found/);
      assert.match(res.stderr, /omb handoff --to/);
    });
  });

  it("top-level and local help include review", async () => {
    await withTempDir("omb-review-cli-help-", async (cwd) => {
      const top = runOmb(cwd, ["--help"]);
      assert.equal(top.status, 0, top.stderr || top.stdout);
      assert.match(top.stdout, /omb review/);
      const local = runOmb(cwd, ["review", "--help"]);
      assert.equal(local.status, 0, local.stderr || local.stdout);
      assert.match(local.stdout, /Usage:\s*omb review/);
    });
  });
});
