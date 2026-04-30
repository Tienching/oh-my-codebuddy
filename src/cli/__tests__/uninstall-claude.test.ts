import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

function runOmb(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string>,
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, "..", "..", "..");
  const ombBin = join(repoRoot, "dist", "cli", "omb.js");
  const result = spawnSync(process.execPath, [ombBin, ...argv], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      OMB_AUTO_UPDATE: "0",
      OMB_NOTIFY_FALLBACK: "0",
      OMB_HOOK_DERIVED_SIGNALS: "0",
      ...envOverrides,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.message || "",
  };
}

function shouldSkipForSpawnPermissions(err: string): boolean {
  return /(EPERM|EACCES)/i.test(err);
}

describe("uninstall --provider claude", () => {
  it("removes OMB-managed Claude artifacts while preserving user settings and hooks", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-uninstall-claude-"));
    try {
      const home = join(wd, "home");
      const claudeHome = join(home, ".claude");
      const hooksPath = join(claudeHome, "hooks", "hooks.json");
      const env = { HOME: home, CLAUDE_HOME: claudeHome };
      await mkdir(claudeHome, { recursive: true });
      await mkdir(join(claudeHome, "hooks"), { recursive: true });
      // Pre-seed: user-owned settings.json with unrelated mcpServers (OMB does
      // not touch this on claude). OMB must not mutate any of these fields.
      await writeFile(
        join(claudeHome, "settings.json"),
        JSON.stringify(
          {
            enabledPlugins: { "user@plugin": true },
            mcpServers: {
              "user-tool": { command: "user-tool", args: ["serve"], enabled: true },
            },
          },
          null,
          2,
        ),
      );
      // Pre-seed: user-owned hook entry at the Claude-native subdirectory path.
      // OMB will merge managed entries alongside it, and uninstall should only
      // remove OMB-managed entries.
      await writeFile(
        hooksPath,
        JSON.stringify(
          {
            hooks: {
              SessionStart: [{ hooks: [{ type: "command", command: "echo user-hook" }] }],
            },
          },
          null,
          2,
        ),
      );

      const setup = runOmb(wd, ["setup", "--provider", "claude", "--scope", "user", "--force"], env);
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0, setup.stderr || setup.stdout);
      assert.match(await readFile(hooksPath, "utf-8"), /claude-native-hook\.js/);
      // Guard: no flat hooks.json was produced by setup.
      assert.equal(existsSync(join(claudeHome, "hooks.json")), false);

      const uninstall = runOmb(wd, ["uninstall", "--provider", "claude", "--scope", "user"], env);
      assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
      assert.match(uninstall.stdout, /Resolved provider: claude/);

      const settings = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf-8")) as {
        enabledPlugins?: Record<string, boolean>;
        mcpServers?: Record<string, unknown>;
      };
      assert.deepEqual(settings.enabledPlugins, { "user@plugin": true });
      assert.deepEqual(settings.mcpServers, {
        "user-tool": { command: "user-tool", args: ["serve"], enabled: true },
      });
      assert.equal(existsSync(join(claudeHome, ".omb-config.json")), false);
      assert.equal(existsSync(join(claudeHome, "AGENTS.md")), false);

      const hooks = await readFile(hooksPath, "utf-8");
      assert.match(hooks, /echo user-hook/);
      assert.doesNotMatch(hooks, /claude-native-hook\.js/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
