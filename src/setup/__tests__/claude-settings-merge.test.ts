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

  // Regression guard for architect-review M1 (2026-04-30):
  // An earlier version of setup.ts called syncClaudeCodeMcpSettings() for every
  // user-scope setup run, unconditionally on provider. With a non-empty shared
  // MCP registry, that function wrote OMB-managed mcpServers entries into
  // `~/.claude/settings.json`, silently no-opping for Claude CLI (which does
  // not read that field) and violating the shared-ownership contract.
  //
  // The fix (commit after ea0152eb) removed the call entirely, since no known
  // Claude product reads `~/.claude/settings.json#mcpServers`. This test pins
  // the contract by running setup with a populated shared MCP registry
  // (namely the OMB built-ins: omb_state / omb_memory / omb_code_intel /
  // omb_trace, which are always present at setup time) and asserting that
  // settings.json.mcpServers is never touched.
  it("does not inject OMB built-in MCP servers into ~/.claude/settings.json (M1 guard)", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-claude-mcp-nowrite-"));
    try {
      const home = join(wd, "home");
      const claudeHome = join(home, ".claude");
      const settingsPath = join(claudeHome, "settings.json");
      const env = { HOME: home, CLAUDE_HOME: claudeHome };
      await mkdir(claudeHome, { recursive: true });
      // Start from a file that already contains user-managed mcpServers, so
      // we can prove OMB leaves it byte-identical.
      const seeded = {
        mcpServers: {
          "user-mcp": { command: "user-mcp", args: ["start"] },
        },
      };
      await writeFile(settingsPath, JSON.stringify(seeded, null, 2));

      const setup = runOmb(wd, ["setup", "--provider", "claude", "--scope", "user", "--force"], env);
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0, setup.stderr || setup.stdout);

      const after = JSON.parse(await readFile(settingsPath, "utf-8")) as {
        mcpServers?: Record<string, unknown>;
      };
      // User's entry preserved byte-identical.
      assert.deepEqual(after.mcpServers, seeded.mcpServers);
      // And none of the 4 OMB built-ins leaked in.
      const afterMcp = (after.mcpServers ?? {}) as Record<string, unknown>;
      for (const omb of ["omb_state", "omb_memory", "omb_code_intel", "omb_trace"]) {
        assert.equal(
          afterMcp[omb],
          undefined,
          `${omb} must not be written to ~/.claude/settings.json#mcpServers (M1 contract)`,
        );
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  // Also guard codebuddy + codex leader setups: the old syncClaudeCodeMcpSettings
  // was called unconditionally on scope === "user" regardless of provider, so
  // a user running `omb setup --provider codebuddy --scope user` would also
  // see OMB entries appear in `~/.claude/settings.json` even though they
  // never asked for claude. After the M1 fix that side-effect is gone.
  it("does not write ~/.claude/settings.json when running non-claude leader setup (M1 guard)", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-claude-no-touch-"));
    try {
      const home = join(wd, "home");
      const claudeHome = join(home, ".claude");
      const claudeSettingsPath = join(claudeHome, "settings.json");
      const env = { HOME: home, CLAUDE_HOME: claudeHome };
      // Deliberately do NOT create ~/.claude/ beforehand. The user does not
      // have Claude installed. Running codebuddy setup must not touch
      // ~/.claude/ at all.

      const setup = runOmb(wd, ["setup", "--provider", "codebuddy", "--scope", "user", "--force"], env);
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0, setup.stderr || setup.stdout);

      assert.equal(
        existsSync(claudeHome),
        false,
        "codebuddy-only setup must not create ~/.claude/",
      );
      assert.equal(
        existsSync(claudeSettingsPath),
        false,
        "codebuddy-only setup must not create ~/.claude/settings.json",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
