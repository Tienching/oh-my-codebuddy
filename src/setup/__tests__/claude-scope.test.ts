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
  envOverrides: Record<string, string> = {},
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

describe("Claude setup scope", () => {
  it("installs user-scope Claude provider files without a TOML config", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-claude-"));
    try {
      const home = join(wd, "home");
      const claudeHome = join(home, ".claude");
      await mkdir(claudeHome, { recursive: true });
      await writeFile(
        join(claudeHome, "settings.json"),
        JSON.stringify({ enabledPlugins: { "x@y": true }, model: "sonnet" }, null, 2),
      );

      const env = { HOME: home, CLAUDE_HOME: claudeHome };
      const res = runOmb(wd, ["setup", "--provider", "claude", "--scope", "user", "--force"], env);
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const agentsPath = join(claudeHome, "AGENTS.md");
      // Claude CLI reads hooks from <home>/hooks/hooks.json (subdirectory),
      // not a flat <home>/hooks.json.
      const hooksPath = join(claudeHome, "hooks", "hooks.json");
      const settingsPath = join(claudeHome, "settings.json");
      const ombConfigPath = join(claudeHome, ".omb-config.json");

      assert.equal(existsSync(agentsPath), true);
      assert.equal(existsSync(hooksPath), true);
      assert.equal(existsSync(settingsPath), true);
      assert.equal(existsSync(ombConfigPath), true);
      assert.equal(existsSync(join(claudeHome, "config.toml")), false);
      // Guard: legacy flat path must NOT be written, otherwise Claude CLI would
      // silently ignore OMB hooks.
      assert.equal(existsSync(join(claudeHome, "hooks.json")), false);

      const agents = await readFile(agentsPath, "utf-8");
      assert.doesNotMatch(agents, /~\/\.codex/);
      assert.doesNotMatch(agents, /~\/\.codebuddy/);
      assert.match(agents, /~\/\.claude\/skills/);

      const hooks = await readFile(hooksPath, "utf-8");
      assert.match(hooks, /claude-native-hook\.js/);

      // Claude CLI does NOT read MCP from <home>/settings.json#mcpServers. OMB
      // therefore preserves user-owned settings fields and does not inject MCP
      // there; MCP integration for claude is tracked as a follow-up (skill-
      // packaged MCP clients). See PRD §9 out-of-scope follow-ups.
      const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
        enabledPlugins?: Record<string, boolean>;
        model?: string;
        mcpServers?: Record<string, unknown>;
      };
      assert.deepEqual(settings.enabledPlugins, { "x@y": true });
      assert.equal(settings.model, "sonnet");
      assert.equal(settings.mcpServers, undefined);

      const ombConfig = JSON.parse(await readFile(ombConfigPath, "utf-8")) as {
        env?: Record<string, string>;
      };
      assert.equal(ombConfig.env?.USE_OMB_EXPLORE_CMD, "1");
      assert.equal(ombConfig.env?.OMB_EXPERIMENTAL_COMMAND_TEMPLATES, "0");

      const hooksBefore = await readFile(hooksPath, "utf-8");
      const rerun = runOmb(wd, ["setup", "--provider", "claude", "--scope", "user", "--force"], env);
      assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
      assert.equal(await readFile(hooksPath, "utf-8"), hooksBefore);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("installs all three user provider homes for --provider all", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-all-"));
    try {
      const home = join(wd, "home");
      const env = {
        HOME: home,
        CODEBUDDY_HOME: join(home, ".codebuddy"),
        CODEX_HOME: join(home, ".codex"),
        CLAUDE_HOME: join(home, ".claude"),
      };
      const res = runOmb(wd, ["setup", "--provider", "all", "--scope", "user", "--force"], env);
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      for (const providerDir of [".codebuddy", ".codex", ".claude"]) {
        assert.equal(existsSync(join(home, providerDir, "AGENTS.md")), true, providerDir);
        const hooksPath =
          providerDir === ".claude"
            ? join(home, providerDir, "hooks", "hooks.json")
            : join(home, providerDir, "hooks.json");
        assert.equal(existsSync(hooksPath), true, providerDir);
      }
      assert.equal(existsSync(join(home, ".claude", "config.toml")), false);
      // Guard: legacy flat claude hooks path must not exist.
      assert.equal(existsSync(join(home, ".claude", "hooks.json")), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("installs project-scope Claude provider files under .claude", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-claude-project-"));
    try {
      const home = join(wd, "home");
      const res = runOmb(wd, ["setup", "--provider", "claude", "--scope", "project", "--force"], {
        HOME: home,
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      assert.equal(existsSync(join(wd, ".claude", "AGENTS.md")), false);
      assert.equal(existsSync(join(wd, "AGENTS.md")), true);
      assert.equal(existsSync(join(wd, ".claude", "hooks", "hooks.json")), true);
      assert.equal(existsSync(join(wd, ".claude", "settings.json")), true);
      assert.equal(existsSync(join(wd, ".claude", ".omb-config.json")), true);
      assert.equal(existsSync(join(wd, ".claude", "config.toml")), false);
      // Guard: legacy flat hooks path must not exist in project scope either.
      assert.equal(existsSync(join(wd, ".claude", "hooks.json")), false);
      assert.match(await readFile(join(wd, "AGENTS.md"), "utf-8"), /\.\/\.claude\/skills/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
