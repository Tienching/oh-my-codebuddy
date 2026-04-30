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

describe("Claude settings.json shared ownership", () => {
  it("setup preserves user-owned settings.json fields without injecting MCP entries", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-claude-settings-"));
    try {
      const home = join(wd, "home");
      const claudeHome = join(home, ".claude");
      const settingsPath = join(claudeHome, "settings.json");
      const env = { HOME: home, CLAUDE_HOME: claudeHome };
      await mkdir(claudeHome, { recursive: true });
      const originalSettings = {
        enabledPlugins: { "x@y": true },
        model: "claude-opus-4-7",
        skipDangerousModePermissionPrompt: false,
        mcpServers: {
          "user-tool": {
            command: "custom-tool",
            args: ["serve"],
            enabled: true,
          },
        },
      };
      await writeFile(settingsPath, JSON.stringify(originalSettings, null, 2));

      const setup = runOmb(wd, ["setup", "--provider", "claude", "--scope", "user", "--force"], env);
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0, setup.stderr || setup.stdout);

      // Claude CLI does not read <home>/settings.json#mcpServers, so OMB must
      // not inject OMB MCP entries there (that would silently no-op). The
      // user's entire mcpServers map and other fields must be preserved
      // untouched (shared-ownership contract).
      const afterSetup = JSON.parse(await readFile(settingsPath, "utf-8")) as {
        enabledPlugins?: Record<string, boolean>;
        model?: string;
        skipDangerousModePermissionPrompt?: boolean;
        mcpServers?: Record<string, unknown>;
      };
      assert.deepEqual(afterSetup.enabledPlugins, { "x@y": true });
      assert.equal(afterSetup.model, "claude-opus-4-7");
      assert.equal(afterSetup.skipDangerousModePermissionPrompt, false);
      assert.deepEqual(afterSetup.mcpServers, originalSettings.mcpServers);
      // Negative guards: no OMB keys leaked in.
      const afterSetupMcp = (afterSetup.mcpServers ?? {}) as Record<string, unknown>;
      assert.equal(afterSetupMcp.omb_state, undefined);
      assert.equal(afterSetupMcp.omb_trace, undefined);

      const uninstall = runOmb(wd, ["uninstall", "--provider", "claude", "--scope", "user"], env);
      assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);

      const afterUninstall = JSON.parse(await readFile(settingsPath, "utf-8")) as {
        enabledPlugins?: Record<string, boolean>;
        model?: string;
        skipDangerousModePermissionPrompt?: boolean;
        mcpServers?: Record<string, unknown>;
      };
      assert.deepEqual(afterUninstall.enabledPlugins, { "x@y": true });
      assert.equal(afterUninstall.model, "claude-opus-4-7");
      assert.equal(afterUninstall.skipDangerousModePermissionPrompt, false);
      assert.deepEqual(afterUninstall.mcpServers, originalSettings.mcpServers);
      assert.equal(existsSync(join(claudeHome, ".omb-config.json")), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
