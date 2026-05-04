import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

async function installFakeClaude(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await symlink("/bin/echo", join(binDir, "claude"));
}

describe("doctor --provider claude", { concurrency: false }, () => {
  it("recognizes a fresh Claude provider install", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-doctor-claude-"));
    try {
      const home = join(wd, "home");
      const bin = join(wd, "bin");
      const claudeHome = join(home, ".claude");
      await installFakeClaude(bin);
      const env = {
        HOME: home,
        CLAUDE_HOME: claudeHome,
        PATH: `${bin}:/usr/bin:/bin`,
      };

      const setup = runOmb(wd, ["setup", "--provider", "claude", "--scope", "user", "--force"], env);
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0, setup.stderr || setup.stdout);

      const doctor = runOmb(wd, ["doctor", "--provider", "claude"], env);
      assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
      assert.match(doctor.stdout, /Resolved setup provider: claude \(from --provider\)/);
      assert.match(doctor.stdout, /\[OK\] Claude CLI: installed/);
      assert.match(doctor.stdout, /\[OK\] Claude Config: \.omb-config\.json present|(\[OK\] Config: \.omb-config\.json present)/);
      // After the Claude MCP skill-packaging follow-up (post-M1), OMB ships
      // a dedicated `<home>/omb-mcp.json` listing the 4 built-in OMB MCP
      // servers. Doctor must recognize that file as a healthy MCP manifest
      // (the manifest exists, contains all 4 built-ins, and Doctor prints
      // the exact `claude --mcp-config <path>` activation command).
      assert.match(
        doctor.stdout,
        /\[OK\] (?:Claude )?MCP Servers: 4 OMB MCP servers declared in .+\/\.claude\/omb-mcp\.json/,
      );
      assert.match(
        doctor.stdout,
        /claude --mcp-config .+\/\.claude\/omb-mcp\.json/,
      );
      assert.match(doctor.stdout, /\[OK\] Explore routing: enabled by default|\[OK\] Claude Explore routing: enabled by default/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("warns on partial Claude config and isolates provider homes", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-doctor-claude-partial-"));
    try {
      const home = join(wd, "home");
      const bin = join(wd, "bin");
      const claudeHome = join(home, ".claude");
      await installFakeClaude(bin);
      await mkdir(claudeHome, { recursive: true });
      await mkdir(join(home, ".codebuddy"), { recursive: true });
      await writeFile(join(home, ".codebuddy", ".omb-config.json"), JSON.stringify({ env: { USE_OMB_EXPLORE_CMD: "1" } }));
      await writeFile(join(claudeHome, "settings.json"), JSON.stringify({ model: "sonnet" }));

      const res = runOmb(wd, ["doctor", "--provider", "claude"], {
        HOME: home,
        CLAUDE_HOME: claudeHome,
        CODEBUDDY_HOME: join(home, ".codebuddy"),
        PATH: `${bin}:/usr/bin:/bin`,
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const output = `${res.stdout}\n${res.stderr}`;
      assert.match(output, /Claude home: .*\.claude/);
      assert.match(output, /Config: settings\.json exists but no OMB entries yet/);
      assert.doesNotMatch(output, /\.codebuddy\/\.omb-config\.json present/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("reports a missing Claude binary cleanly", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-doctor-claude-missing-bin-"));
    try {
      const home = join(wd, "home");
      const emptyBin = join(wd, "empty-bin");
      const claudeHome = join(home, ".claude");
      await mkdir(emptyBin, { recursive: true });
      await mkdir(claudeHome, { recursive: true });
      await writeFile(join(claudeHome, ".omb-config.json"), JSON.stringify({ env: { USE_OMB_EXPLORE_CMD: "1" } }));
      await writeFile(join(claudeHome, "settings.json"), JSON.stringify({ mcpServers: { omb_state: { command: "node", args: [] } } }));

      const res = runOmb(wd, ["doctor", "--provider", "claude"], {
        HOME: home,
        CLAUDE_HOME: claudeHome,
        PATH: emptyBin,
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        `${res.stdout}\n${res.stderr}`,
        /Claude CLI: not found - install Claude Code CLI and ensure claude is on PATH/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
