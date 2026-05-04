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

/**
 * End-to-end regression coverage for Claude MCP skill packaging
 * (post-ea0152eb / post-M1 follow-up):
 *
 * Before this change, `omb setup --provider claude` left Claude without any
 * MCP wiring because Claude CLI silently ignores `settings.json#mcpServers`.
 * The skill-packaging compromise is to generate a dedicated, OMB-owned
 * `<claude-home>/omb-mcp.json` (shape-compatible with project `.mcp.json`
 * files) that users activate via `claude --mcp-config <path>` or by merging
 * its `mcpServers` block into their own `.mcp.json`. Doctor verifies the
 * manifest; uninstall removes it; the file never leaks into non-claude
 * provider setups.
 */
describe("Claude omb-mcp.json manifest", { concurrency: false }, () => {
  it("setup --provider claude writes a well-formed omb-mcp.json with 4 built-ins", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-claude-mcp-basic-"));
    try {
      const home = join(wd, "home");
      const claudeHome = join(home, ".claude");
      const env = { HOME: home, CLAUDE_HOME: claudeHome };

      const setup = runOmb(
        wd,
        ["setup", "--provider", "claude", "--scope", "user", "--yes"],
        env,
      );
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0, setup.stderr || setup.stdout);

      // Setup prints the activation hint.
      assert.match(
        setup.stdout,
        /Claude MCP manifest ready.*omb-mcp\.json/,
      );
      assert.match(
        setup.stdout,
        /claude --mcp-config .+\/omb-mcp\.json/,
      );

      const manifestPath = join(claudeHome, "omb-mcp.json");
      assert.equal(existsSync(manifestPath), true);

      const parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as {
        mcpServers?: Record<string, { command?: string; args?: string[] }>;
      };
      const mcpServers = parsed.mcpServers ?? {};
      for (const name of [
        "omb_state",
        "omb_memory",
        "omb_code_intel",
        "omb_trace",
      ]) {
        assert.ok(
          mcpServers[name],
          `built-in MCP "${name}" missing from omb-mcp.json`,
        );
        const entry = mcpServers[name]!;
        assert.equal(entry.command, "node");
        assert.ok(Array.isArray(entry.args));
        assert.match(
          String(entry.args?.[0] ?? ""),
          new RegExp(
            `dist\\/mcp\\/${name.replace(/^omb_/, "").replace(/_/g, "-")}-server\\.js$`,
          ),
          `built-in MCP "${name}" does not point at its dist server script`,
        );
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("setup does NOT leak omb-mcp.json into a non-claude provider home", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-claude-mcp-no-leak-"));
    try {
      const home = join(wd, "home");
      const env = { HOME: home };

      const setup = runOmb(
        wd,
        ["setup", "--provider", "codebuddy", "--scope", "user", "--yes"],
        env,
      );
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0);

      // codebuddy setup must not create ~/.claude/ or omb-mcp.json.
      assert.equal(existsSync(join(home, ".claude")), false);
      assert.equal(
        existsSync(join(home, ".claude", "omb-mcp.json")),
        false,
      );
      assert.equal(
        existsSync(join(home, ".codebuddy", "omb-mcp.json")),
        false,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("includes OMB-prefixed entries from the shared MCP registry; ignores non-OMB entries", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-claude-mcp-registry-"));
    try {
      const home = join(wd, "home");
      const claudeHome = join(home, ".claude");
      const registryDir = join(home, ".omb");
      await mkdir(registryDir, { recursive: true });
      // Shared registry -- `loadUnifiedMcpRegistry` reads ~/.omb/mcp-registry.json.
      // Seed with one OMB-prefixed custom server + one third-party server.
      await writeFile(
        join(registryDir, "mcp-registry.json"),
        JSON.stringify({
          omb_custom_tool: {
            command: "node",
            args: ["/tmp/omb-custom-tool.js"],
            enabled: true,
          },
          third_party_tool: {
            command: "echo",
            args: ["should-not-appear"],
            enabled: true,
          },
        }),
      );
      const env = { HOME: home, CLAUDE_HOME: claudeHome };

      const setup = runOmb(
        wd,
        ["setup", "--provider", "claude", "--scope", "user", "--yes"],
        env,
      );
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0, setup.stderr || setup.stdout);

      const manifest = JSON.parse(
        await readFile(join(claudeHome, "omb-mcp.json"), "utf-8"),
      ) as { mcpServers?: Record<string, unknown> };
      const keys = Object.keys(manifest.mcpServers ?? {});
      assert.ok(
        keys.includes("omb_custom_tool"),
        "OMB-prefixed registry entry must be included",
      );
      assert.ok(
        !keys.includes("third_party_tool"),
        "non-OMB-prefixed registry entry must be excluded (shared-ownership)",
      );
      // Built-ins still present.
      assert.ok(keys.includes("omb_state"));
      assert.ok(keys.includes("omb_trace"));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("is idempotent: running setup twice produces the same omb-mcp.json", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-claude-mcp-idempotent-"));
    try {
      const home = join(wd, "home");
      const claudeHome = join(home, ".claude");
      const env = { HOME: home, CLAUDE_HOME: claudeHome };
      const manifestPath = join(claudeHome, "omb-mcp.json");

      const first = runOmb(
        wd,
        ["setup", "--provider", "claude", "--scope", "user", "--yes"],
        env,
      );
      if (shouldSkipForSpawnPermissions(first.error)) return;
      assert.equal(first.status, 0);
      const before = await readFile(manifestPath, "utf-8");

      const second = runOmb(
        wd,
        ["setup", "--provider", "claude", "--scope", "user", "--yes", "--force"],
        env,
      );
      assert.equal(second.status, 0);
      const after = await readFile(manifestPath, "utf-8");

      assert.equal(after, before, "omb-mcp.json must be byte-identical on re-setup");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uninstall --provider claude removes omb-mcp.json but preserves user-owned settings.json", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-claude-mcp-uninstall-"));
    try {
      const home = join(wd, "home");
      const claudeHome = join(home, ".claude");
      await mkdir(claudeHome, { recursive: true });
      const userSettings = {
        enabledPlugins: { foo: true },
        model: "claude-opus-4-7",
      };
      await writeFile(
        join(claudeHome, "settings.json"),
        JSON.stringify(userSettings, null, 2),
      );
      const env = { HOME: home, CLAUDE_HOME: claudeHome };

      const setup = runOmb(
        wd,
        ["setup", "--provider", "claude", "--scope", "user", "--yes"],
        env,
      );
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0);
      assert.equal(existsSync(join(claudeHome, "omb-mcp.json")), true);

      const uninstall = runOmb(
        wd,
        ["uninstall", "--provider", "claude", "--scope", "user", "--yes"],
        env,
      );
      assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);

      assert.equal(
        existsSync(join(claudeHome, "omb-mcp.json")),
        false,
        "uninstall must remove OMB-owned omb-mcp.json",
      );
      // User-owned fields preserved.
      const after = JSON.parse(
        await readFile(join(claudeHome, "settings.json"), "utf-8"),
      ) as Record<string, unknown>;
      assert.deepEqual(after.enabledPlugins, { foo: true });
      assert.equal(after.model, "claude-opus-4-7");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("doctor flags a missing omb-mcp.json with an actionable warning", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-claude-mcp-missing-"));
    try {
      const home = join(wd, "home");
      const claudeHome = join(home, ".claude");
      // Create claude home but never run setup.
      await mkdir(claudeHome, { recursive: true });
      const env = { HOME: home, CLAUDE_HOME: claudeHome };

      const doctor = runOmb(wd, ["doctor", "--provider", "claude"], env);
      if (shouldSkipForSpawnPermissions(doctor.error)) return;
      assert.equal(doctor.status, 0);
      assert.match(
        doctor.stdout,
        /\[!!\] (?:Claude )?MCP Servers: .+\/omb-mcp\.json not found/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("doctor flags a truncated omb-mcp.json missing one of the built-ins", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-claude-mcp-truncated-"));
    try {
      const home = join(wd, "home");
      const claudeHome = join(home, ".claude");
      const env = { HOME: home, CLAUDE_HOME: claudeHome };

      const setup = runOmb(
        wd,
        ["setup", "--provider", "claude", "--scope", "user", "--yes"],
        env,
      );
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0);

      const manifestPath = join(claudeHome, "omb-mcp.json");
      const parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as {
        mcpServers?: Record<string, unknown>;
      };
      const mcpServers = parsed.mcpServers ?? {};
      delete mcpServers.omb_trace;
      await writeFile(
        manifestPath,
        `${JSON.stringify({ mcpServers }, null, 2)}\n`,
      );

      const doctor = runOmb(wd, ["doctor", "--provider", "claude"], env);
      assert.equal(doctor.status, 0);
      assert.match(
        doctor.stdout,
        /\[!!\] (?:Claude )?MCP Servers: .+omb-mcp\.json missing built-in OMB servers: omb_trace/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
