import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    env: {
      ...process.env,
      HOME: join(cwd, "home"),
      CODEBUDDY_HOME: join(cwd, "home", ".codebuddy"),
      CODEX_HOME: join(cwd, "home", ".codex"),
      CLAUDE_HOME: join(cwd, "home", ".claude"),
      OMB_AUTO_UPDATE: "0",
      OMB_NOTIFY_FALLBACK: "0",
      OMB_HOOK_DERIVED_SIGNALS: "0",
    },
  });
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("omb handoff", () => {
  it("is recognized as a first-class local-help command", () => {
    assert.deepEqual(resolveCliInvocation(["handoff", "claude"]), { command: "handoff", launchArgs: [] });
    assert.equal(commandOwnsLocalHelp("handoff"), true);
  });

  it("creates a handoff with positional provider", async () => {
    await withTempDir("omb-handoff-cli-pos-", async (cwd) => {
      const result = runOmb(cwd, ["handoff", "claude", "--task", "continue payment webhook work"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Created handoff:/);
      assert.equal(existsSync(join(cwd, ".omb", "handoffs", "latest.md")), true);
      const latest = await readFile(join(cwd, ".omb", "handoffs", "latest.md"), "utf-8");
      assert.match(latest, /continue payment webhook work/);
    });
  });

  it("creates a handoff with --to provider and reason", async () => {
    await withTempDir("omb-handoff-cli-to-", async (cwd) => {
      const result = runOmb(cwd, ["handoff", "--to", "codex", "--reason", "test repair"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Review: omb review --handoff latest --with codex/);
      assert.match(result.stdout, /Launch: omb switch --to codex --handoff latest --launch/);
      const latest = await readFile(join(cwd, ".omb", "handoffs", "latest.md"), "utf-8");
      assert.match(latest, /test repair/);
    });
  });

  it("keeps gemini handoffs artifact/review-only in CLI guidance", async () => {
    await withTempDir("omb-handoff-cli-gemini-", async (cwd) => {
      const result = runOmb(cwd, ["handoff", "--to", "gemini"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Review: omb review --handoff latest --with gemini/);
      assert.doesNotMatch(result.stdout, /Launch:/);
    });
  });

  it("dry-run prints markdown but writes nothing", async () => {
    await withTempDir("omb-handoff-cli-dry-", async (cwd) => {
      const result = runOmb(cwd, ["handoff", "--to", "claude", "--dry-run", "--task", "preview only"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /# OMB Provider Handoff/);
      assert.match(result.stdout, /preview only/);
      assert.equal(existsSync(join(cwd, ".omb")), false);
    });
  });

  it("list on empty workspace is friendly", async () => {
    await withTempDir("omb-handoff-cli-list-", async (cwd) => {
      const result = runOmb(cwd, ["handoff", "list"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /No handoffs found/);
    });
  });

  it("show latest missing exits non-zero with actionable error", async () => {
    await withTempDir("omb-handoff-cli-show-missing-", async (cwd) => {
      const result = runOmb(cwd, ["handoff", "show", "latest"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /No latest handoff found/i);
    });
  });

  it("top-level and local help include handoff", async () => {
    await withTempDir("omb-handoff-cli-help-", async (cwd) => {
      const top = runOmb(cwd, ["--help"]);
      assert.equal(top.status, 0, top.stderr || top.stdout);
      assert.match(top.stdout, /omb handoff/);

      const local = runOmb(cwd, ["handoff", "--help"]);
      assert.equal(local.status, 0, local.stderr || local.stdout);
      assert.match(local.stdout, /Usage:\s*omb handoff/);
      assert.doesNotMatch(local.stdout, /Multi-agent orchestration for/);
    });
  });
});
