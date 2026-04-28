import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function runOmb(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, "..", "..", "..");
  const ombBin = join(repoRoot, "dist", "cli", "omb.js");
  const resolvedHome = envOverrides.HOME ?? process.env.HOME;
  const result = spawnSync(process.execPath, [ombBin, ...argv], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      ...(resolvedHome && !envOverrides.CODEBUDDY_HOME
        ? { CODEBUDDY_HOME: join(resolvedHome, ".codebuddy") }
        : {}),
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
  return typeof err === "string" && /(EPERM|EACCES)/i.test(err);
}

describe("omb setup scope behavior", () => {
  it("accepts --scope project form", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });
      const bySeparateArg = runOmb(
        wd,
        ["setup", "--dry-run", "--scope", "project"],
        { HOME: home },
      );
      if (shouldSkipForSpawnPermissions(bySeparateArg.error)) return;
      assert.equal(
        bySeparateArg.status,
        0,
        bySeparateArg.stderr || bySeparateArg.stdout,
      );
      assert.match(bySeparateArg.stdout, /Using setup scope: project/);

      const byEqualsArg = runOmb(wd, ["setup", "--dry-run", "--scope=user"], {
        HOME: home,
      });
      if (shouldSkipForSpawnPermissions(byEqualsArg.error)) return;
      assert.equal(
        byEqualsArg.status,
        0,
        byEqualsArg.stderr || byEqualsArg.stdout,
      );
      assert.match(byEqualsArg.stdout, /Using setup scope: user/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses persisted setup scope when --scope is omitted", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-scope-"));
    try {
      const ombDir = join(wd, ".omb");
      const home = join(wd, "home");
      await mkdir(ombDir, { recursive: true });
      await mkdir(home, { recursive: true });
      await writeFile(
        join(ombDir, "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );

      const res = runOmb(wd, ["setup", "--dry-run"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Using setup scope: project \(from \.omb\/setup-scope\.json\)/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("doctor respects persisted project setup scope paths", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-doctor-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );

      await mkdir(join(wd, ".codebuddy", "prompts"), { recursive: true });
      await mkdir(join(wd, ".codebuddy", "skills", "sample-skill"), {
        recursive: true,
      });
      await mkdir(join(wd, ".omb", "state"), { recursive: true });
      await writeFile(
        join(wd, ".codebuddy", "prompts", "executor.md"),
        "# executor\n",
      );
      await writeFile(
        join(wd, ".codebuddy", "skills", "sample-skill", "SKILL.md"),
        "# skill\n",
      );
      await writeFile(
        join(wd, ".codebuddy", "config.toml"),
        'omb_enabled = true\n[mcp_servers.omb_state]\ncommand = "node"\n',
      );

      const res = runOmb(wd, ["doctor"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Resolved setup scope: project \(from \.omb\/setup-scope\.json\)/,
      );
      assert.match(
        res.stdout,
        new RegExp(
          `CodeBuddy home: (?:/private)?${wd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.codebuddy`,
        ),
      );
      assert.doesNotMatch(res.stdout, /CodeBuddy home: .*\/home\/\.codebuddy/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("shows provider source when --provider is set", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-doctor-provider-source-"));
    try {
      const home = join(wd, "home");
      const codexHome = join(home, ".codex");
      await mkdir(home, { recursive: true });
      await mkdir(codexHome, { recursive: true });

      const res = runOmb(wd, ["doctor", "--provider", "codex"], {
        HOME: home,
        CODEX_HOME: codexHome,
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Resolved setup provider: codex \(from --provider\)/,
      );
      assert.doesNotMatch(res.stdout, /Resolved setup provider: .*from --scope/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not persist setup scope on --dry-run", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });
      const res = runOmb(wd, ["setup", "--scope", "project", "--dry-run"], {
        HOME: home,
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.equal(existsSync(join(wd, ".omb", "setup-scope.json")), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("project scope writes prompts/skills/config/native-agents under cwd", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });
      const res = runOmb(wd, ["setup", "--scope", "project"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const localPrompts = join(wd, ".codebuddy", "prompts");
      const localSkills = join(wd, ".codebuddy", "skills");
      const localConfig = join(wd, ".codebuddy", "config.toml");
      const localHooks = join(wd, ".codebuddy", "hooks.json");
      const localAgents = join(wd, ".codebuddy", "agents");
      const scopeFile = join(wd, ".omb", "setup-scope.json");
      const agentsMdPath = join(wd, "AGENTS.md");

      assert.equal(existsSync(localPrompts), true);
      assert.equal(existsSync(localSkills), true);
      assert.equal(existsSync(localConfig), true);
      assert.equal(existsSync(localHooks), true);
      assert.equal(existsSync(localAgents), true);
      assert.equal(existsSync(join(localAgents, "executor.toml")), true);
      assert.equal(existsSync(join(localSkills, "help", "SKILL.md")), true);
      assert.equal(
        existsSync(join(localSkills, "ask-claude", "SKILL.md")),
        true,
      );
      assert.equal(
        existsSync(join(localSkills, "ask-gemini", "SKILL.md")),
        true,
      );
      assert.ok(
        (await readdir(localPrompts)).length > 0,
        "local prompts should be installed",
      );
      assert.equal(existsSync(agentsMdPath), true);

      const configToml = await readFile(localConfig, "utf-8");
      assert.match(configToml, /^\[agents\]$/m);
      assert.match(configToml, /^max_threads = 6$/m);
      assert.match(configToml, /^max_depth = 2$/m);
      assert.match(configToml, /^\[env\]$/m);
      assert.match(configToml, /^USE_OMB_EXPLORE_CMD = "1"$/m);
      assert.match(configToml, /^codex_hooks = true$/m);
      const hooksJson = JSON.parse(await readFile(localHooks, "utf-8")) as {
        hooks?: Record<string, unknown>;
      };
      assert.ok(hooksJson.hooks, "hooks.json should include a hooks object");
      assert.ok(hooksJson.hooks?.SessionStart, "hooks.json should register SessionStart");
      assert.ok(hooksJson.hooks?.UserPromptSubmit, "hooks.json should register UserPromptSubmit");
      assert.ok(hooksJson.hooks?.Stop, "hooks.json should register Stop");
      const agentsMd = await readFile(agentsMdPath, "utf-8");
      assert.match(agentsMd, /prompts\/\*\.md/);
      assert.match(agentsMd, /\.\/\.codebuddy\/skills/);
      const persistedScope = JSON.parse(await readFile(scopeFile, "utf-8")) as {
        scope: string;
      };
      assert.equal(persistedScope.scope, "project");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("project scope can install a first-class Codex provider under .codex", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });
      const res = runOmb(wd, ["setup", "--scope", "project", "--provider", "codex"], {
        HOME: home,
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      assert.equal(existsSync(join(wd, ".codex", "prompts")), true);
      assert.equal(existsSync(join(wd, ".codex", "skills", "help", "SKILL.md")), true);
      assert.equal(existsSync(join(wd, ".codex", "agents", "executor.toml")), true);
      assert.equal(existsSync(join(wd, ".codex", "config.toml")), true);
      assert.equal(existsSync(join(wd, ".codex", "hooks.json")), true);
      assert.equal(existsSync(join(wd, ".codebuddy", "config.toml")), false);

      const hooksJson = await readFile(join(wd, ".codex", "hooks.json"), "utf-8");
      assert.match(hooksJson, /codex-native-hook\.js/);
      const agentsMd = await readFile(join(wd, "AGENTS.md"), "utf-8");
      assert.match(agentsMd, /\.\/\.codex\/skills/);
      assert.doesNotMatch(agentsMd, /\.\/\.codebuddy\/skills/);
      const persisted = JSON.parse(
        await readFile(join(wd, ".omb", "setup-scope.json"), "utf-8"),
      ) as { provider?: string; scope: string };
      assert.equal(persisted.scope, "project");
      assert.equal(persisted.provider, "codex");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("project scope can install both CodeBuddy and Codex provider homes", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });
      const res = runOmb(wd, ["setup", "--scope", "project", "--provider=both"], {
        HOME: home,
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      assert.equal(existsSync(join(wd, ".codebuddy", "config.toml")), true);
      assert.equal(existsSync(join(wd, ".codex", "config.toml")), true);
      assert.equal(existsSync(join(wd, ".codebuddy", "skills", "team", "SKILL.md")), true);
      assert.equal(existsSync(join(wd, ".codex", "skills", "team", "SKILL.md")), true);
      const agentsMd = await readFile(join(wd, "AGENTS.md"), "utf-8");
      assert.match(agentsMd, /\.\/\.codex\/skills/);
      const persisted = JSON.parse(
        await readFile(join(wd, ".omb", "setup-scope.json"), "utf-8"),
      ) as { provider?: string; scope: string };
      assert.equal(persisted.provider, "both");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("doctor checks both provider homes when persisted provider is both", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-doctor-provider-both-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });
      const setupRes = runOmb(wd, ["setup", "--scope", "project", "--provider=both"], {
        HOME: home,
      });
      if (shouldSkipForSpawnPermissions(setupRes.error)) return;
      assert.equal(setupRes.status, 0, setupRes.stderr || setupRes.stdout);

    const res = runOmb(wd, ["doctor"], { HOME: home });
    if (shouldSkipForSpawnPermissions(res.error)) return;
    assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Resolved setup provider: both/);
      assert.doesNotMatch(res.stdout, /from --scope/);
      assert.match(
        res.stdout,
        new RegExp(
          `CodeBuddy home: (?:/private)?${wd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.codebuddy`,
        ),
      );
      assert.match(
        res.stdout,
        new RegExp(
          `Codex home: (?:/private)?${wd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.codex`,
        ),
      );
      assert.match(res.stdout, /CodeBuddy Config: config\.toml has OMB entries/);
      assert.match(res.stdout, /Codex Config: config\.toml has OMB entries/);
      assert.match(res.stdout, /CodeBuddy MCP Servers: \d+ servers configured \(OMB present\)/);
      assert.match(res.stdout, /Codex MCP Servers: \d+ servers configured \(OMB present\)/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("setup preserves user hooks while replacing stale OMB wrappers", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-scope-"));
    try {
      const home = join(wd, "home");
      const codexDir = join(wd, ".codebuddy");
      await mkdir(home, { recursive: true });
      await mkdir(codexDir, { recursive: true });
      await writeFile(
        join(codexDir, "hooks.json"),
        JSON.stringify(
          {
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: 'node "/old/dist/scripts/codex-native-hook.js"',
                    },
                    { type: "command", command: "echo keep-me" },
                  ],
                },
              ],
              Stop: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: 'node "/old/dist/scripts/codex-native-hook.js"',
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ) + "\n",
      );

      const res = runOmb(wd, ["setup", "--scope", "project"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const hooksJson = JSON.parse(
        await readFile(join(codexDir, "hooks.json"), "utf-8"),
      ) as {
        hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      };
      const sessionStartHooks = hooksJson.hooks.SessionStart.flatMap((entry) =>
        entry.hooks ?? []
      );
      const stopHooks = hooksJson.hooks.Stop.flatMap((entry) => entry.hooks ?? []);

      assert.equal(
        sessionStartHooks.filter((hook) =>
          String(hook.command ?? "").includes("codebuddy-native-hook.js")
        ).length,
        1,
      );
      assert.equal(
        stopHooks.filter((hook) =>
          String(hook.command ?? "").includes("codebuddy-native-hook.js")
        ).length,
        1,
      );
      assert.match(JSON.stringify(sessionStartHooks), /echo keep-me/);
      assert.doesNotMatch(
        JSON.stringify(hooksJson),
        /\/old\/dist\/scripts\/codex-native-hook\.js/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("defaults to user scope in non-interactive runs when no scope is persisted", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-scope-"));
    try {
      const home = join(wd, "home");
      const existingAgents = "# keep my project agents instructions\n";
      await mkdir(home, { recursive: true });
      await writeFile(join(wd, "AGENTS.md"), existingAgents);
      const res = runOmb(wd, ["setup"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Using setup scope: user/);
      assert.match(
        res.stdout,
        /User scope leaves project AGENTS\.md unchanged\./,
      );

      assert.equal(existsSync(join(home, ".codebuddy", "prompts")), true);
      assert.equal(existsSync(join(home, ".codebuddy", "skills")), true);
      assert.equal(existsSync(join(home, ".codebuddy", "agents")), true);
      assert.equal(existsSync(join(home, ".codebuddy", "hooks.json")), true);
      assert.equal(existsSync(join(home, ".codebuddy", "AGENTS.md")), true);
      assert.equal(existsSync(join(wd, ".omb", "setup-scope.json")), true);
      const persistedScope = JSON.parse(
        await readFile(join(wd, ".omb", "setup-scope.json"), "utf-8"),
      ) as { scope: string };
      assert.equal(persistedScope.scope, "user");
      const agentsMd = await readFile(
        join(home, ".codebuddy", "AGENTS.md"),
        "utf-8",
      );
      assert.match(
        agentsMd,
        /\.codebuddy\/skills|oh-my-codebuddy - Intelligent Multi-Agent Orchestration/,
      );
      assert.equal(
        await readFile(join(wd, "AGENTS.md"), "utf-8"),
        existingAgents,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("doctor does not warn about missing project AGENTS.md for user scope", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-doctor-user-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(join(home, ".codebuddy", "prompts"), { recursive: true });
      await mkdir(join(home, ".codebuddy", "skills", "sample-skill"), {
        recursive: true,
      });
      await mkdir(join(home, ".codebuddy", "agents"), { recursive: true });
      await mkdir(join(wd, ".omb", "state"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "user" }),
      );
      await writeFile(join(home, ".codebuddy", "AGENTS.md"), "# user agents\n");
      await writeFile(
        join(home, ".codebuddy", "prompts", "executor.md"),
        "# executor\n",
      );
      await writeFile(
        join(home, ".codebuddy", "skills", "sample-skill", "SKILL.md"),
        "# skill\n",
      );
      await writeFile(
        join(home, ".codebuddy", "config.toml"),
        'omb_enabled = true\n[mcp_servers.omb_state]\ncommand = "node"\n',
      );

      const res = runOmb(wd, ["doctor"], {
        HOME: home,
        CODEBUDDY_HOME: join(home, ".codebuddy"),
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Resolved setup scope: user \(from \.omb\/setup-scope\.json\)/,
      );
      assert.match(
        res.stdout,
        /\[OK\] AGENTS\.md: found in .*home\/\.codebuddy\/AGENTS\.md/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('migrates legacy "project-local" persisted scope to "project"', async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-scope-"));
    try {
      const ombDir = join(wd, ".omb");
      const home = join(wd, "home");
      await mkdir(ombDir, { recursive: true });
      await mkdir(home, { recursive: true });
      // Write the legacy scope value
      await writeFile(
        join(ombDir, "setup-scope.json"),
        JSON.stringify({ scope: "project-local" }),
      );

      const res = runOmb(wd, ["setup", "--dry-run"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      // Should migrate and use "project"
      assert.match(res.stdout, /Using setup scope: project/);
      // Should log migration warning to stderr
      assert.match(
        res.stderr,
        /Migrating persisted setup scope "project-local"/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("skips overwriting existing AGENTS.md in non-interactive runs without --force", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-scope-"));
    try {
      const home = join(wd, "home");
      const existingAgents = "# custom agents instructions\n\nkeep this file\n";
      await mkdir(home, { recursive: true });
      await writeFile(join(wd, "AGENTS.md"), existingAgents);

      const res = runOmb(wd, ["setup", "--scope=project"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const refreshed = await readFile(join(wd, "AGENTS.md"), "utf-8");
      assert.match(res.stdout, /Skipped AGENTS\.md overwrite/);
      assert.equal(refreshed, existingAgents);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("still refreshes existing AGENTS.md with --force", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-setup-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });
      await writeFile(join(wd, "AGENTS.md"), "# old custom file\n");

      const res = runOmb(wd, ["setup", "--scope=project", "--force"], {
        HOME: home,
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const overwritten = await readFile(join(wd, "AGENTS.md"), "utf-8");
      assert.match(overwritten, /^<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->/);
      assert.match(
        overwritten,
        /# oh-my-(?:codex|codebuddy) - Intelligent Multi-Agent Orchestration/,
      );
      assert.doesNotMatch(overwritten, /# old custom file/);
      assert.match(
        res.stdout,
        /Force mode: enabled additional destructive maintenance/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
