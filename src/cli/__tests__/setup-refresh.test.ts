import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setup } from "../setup.js";

const EXPECTED_PROJECT_GITIGNORE = [
  ".omb/",
  ".codebuddy/*",
  "!.codebuddy/agents/",
  "!.codebuddy/agents/**",
  "!.codebuddy/skills/",
  "!.codebuddy/skills/**",
  ".codebuddy/skills/.system/**",
  "!.codebuddy/prompts/",
  "!.codebuddy/prompts/**",
].join("\n") + "\n";

async function runSetupWithCapturedLogs(
  cwd: string,
  options: Parameters<typeof setup>[0],
): Promise<string> {
  const previousCwd = process.cwd();
  const logs: string[] = [];
  const originalLog = console.log;
  process.chdir(cwd);
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await setup(options);
    return logs.join("\n");
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
  }
}

describe("omx setup refresh summary and dry-run behavior", () => {
  async function runSetupInTempDir(
    wd: string,
    options: Parameters<typeof setup>[0],
  ): Promise<void> {
    const previousCwd = process.cwd();
    process.chdir(wd);
    try {
      await setup(options);
    } finally {
      process.chdir(previousCwd);
    }
  }

  it("prints per-category summary and verbose changed-file detail", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omb", "state"), { recursive: true });
      await runSetupInTempDir(wd, { scope: "project" });

      const skillPath = join(wd, ".codebuddy", "skills", "help", "SKILL.md");
      await writeFile(skillPath, "# locally modified help\n");

      const output = await runSetupWithCapturedLogs(wd, {
        scope: "project",
        verbose: true,
      });
      assert.match(output, /Setup refresh summary:/);
      assert.match(output, /prompts: updated=/);
      assert.match(output, /skills: updated=/);
      assert.match(output, /native_agents: updated=/);
      assert.match(output, /agents_md: updated=/);
      assert.match(output, /config: updated=/);
      assert.match(output, /updated skill help\/SKILL\.md/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not overwrite or create backups during dry-run", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omb", "state"), { recursive: true });
      await runSetupInTempDir(wd, { scope: "project" });

      const skillPath = join(wd, ".codebuddy", "skills", "help", "SKILL.md");
      const customized = "# locally modified help\n";
      await writeFile(skillPath, customized);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: "project",
        dryRun: true,
      });
      assert.equal(await readFile(skillPath, "utf-8"), customized);
      assert.equal(existsSync(join(wd, ".omb", "backups", "setup")), false);
      assert.match(output, /skills: updated=/);
      assert.match(output, /skills: .*backed_up=1/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("logs degraded tmux runtime details in verbose setup when tmux is unavailable", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    const originalPath = process.env.PATH;
    const originalTmux = process.env.TMUX;
    const originalTmuxPane = process.env.TMUX_PANE;
    const originalStdinTty = process.stdin.isTTY;
    const originalStdoutTty = process.stdout.isTTY;

    process.env.PATH = "";
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      const output = await runSetupWithCapturedLogs(wd, {
        scope: "project",
        verbose: true,
      });
      assert.match(output, /Platform runtime: .*tmux=missing/);
      assert.match(output, /reasons=.*tmux_missing/);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
      if (originalTmuxPane === undefined) {
        delete process.env.TMUX_PANE;
      } else {
        process.env.TMUX_PANE = originalTmuxPane;
      }
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalStdinTty,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: originalStdoutTty,
      });
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("creates .gitignore with OMX project ignore rules during project-scoped setup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await runSetupInTempDir(wd, { scope: "project" });

      assert.equal(existsSync(join(wd, ".omb", "state")), true);
      assert.equal(
        await readFile(join(wd, ".gitignore"), "utf-8"),
        EXPECTED_PROJECT_GITIGNORE,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("appends missing OMX project ignore rules to an existing project .gitignore without duplicating them", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await writeFile(join(wd, ".gitignore"), "node_modules/\n");

      await runSetupInTempDir(wd, { scope: "project" });
      await runSetupInTempDir(wd, { scope: "project" });

      const gitignore = await readFile(join(wd, ".gitignore"), "utf-8");
      assert.equal(gitignore, `node_modules/\n${EXPECTED_PROJECT_GITIGNORE}`);
      assert.equal(gitignore.match(/^\.omb\/$/gm)?.length ?? 0, 1);
      assert.equal(gitignore.match(/^\.codebuddy\/\*$/gm)?.length ?? 0, 1);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("ignores project-local config while keeping .codebuddy agents, skills, and prompts trackable", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      const initResult = spawnSync("git", ["init", "-q"], { cwd: wd });
      assert.equal(initResult.status, 0);

      await runSetupInTempDir(wd, { scope: "project" });
      await mkdir(join(wd, ".codebuddy", "skills", ".system"), { recursive: true });
      await writeFile(join(wd, ".codebuddy", "agents", "local.toml"), "# local\n");
      await writeFile(join(wd, ".codebuddy", "prompts", "local.md"), "# local\n");
      await writeFile(
        join(wd, ".codebuddy", "skills", ".system", "cache.json"),
        "{}\n",
      );

      const status = spawnSync(
        "git",
        [
          "status",
          "--short",
          "--ignored",
          ".codebuddy/config.toml",
          ".codebuddy/agents/local.toml",
          ".codebuddy/prompts/local.md",
          ".codebuddy/skills/help/SKILL.md",
          ".codebuddy/skills/.system/cache.json",
        ],
        { cwd: wd, encoding: "utf-8" },
      );
      assert.equal(status.status, 0);
      assert.match(status.stdout, /^!! \.codebuddy\/config\.toml$/m);
      assert.match(status.stdout, /^\?\? \.codebuddy\/agents\/local\.toml$/m);
      assert.match(status.stdout, /^\?\? \.codebuddy\/prompts\/local\.md$/m);
      assert.match(status.stdout, /^\?\? \.codebuddy\/skills\/help\/SKILL\.md$/m);
      assert.match(status.stdout, /^!! \.codebuddy\/skills\/\.system\/cache\.json$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("replaces legacy .codebuddy/.codex ignores so the project allowlist can take effect", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await writeFile(join(wd, ".gitignore"), ".omb/\n.codebuddy/\n.codex/\n");

      await runSetupInTempDir(wd, { scope: "project" });

      const gitignore = await readFile(join(wd, ".gitignore"), "utf-8");
      assert.equal(gitignore, EXPECTED_PROJECT_GITIGNORE);
      assert.equal(gitignore.match(/^\.codebuddy\/$/gm)?.length ?? 0, 0);
      assert.equal(gitignore.match(/^\.codex\/$/gm)?.length ?? 0, 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("creates backup files under the scope-specific setup backup root when refreshing modified managed files", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omb", "state"), { recursive: true });
      await runSetupInTempDir(wd, { scope: "project" });

      const promptPath = join(wd, ".codebuddy", "prompts", "executor.md");
      const oldPrompt = "# local prompt\n";
      await writeFile(promptPath, oldPrompt);

      await runSetupInTempDir(wd, { scope: "project" });

      const backupsRoot = join(wd, ".omb", "backups", "setup");
      assert.equal(existsSync(backupsRoot), true);
      const timestamps = await readdir(backupsRoot);
      assert.ok(timestamps.length >= 1);
      const latestBackup = join(
        backupsRoot,
        timestamps.sort().at(-1)!,
        ".codebuddy",
        "prompts",
        "executor.md",
      );
      assert.equal(existsSync(latestBackup), true);
      assert.equal(await readFile(latestBackup, "utf-8"), oldPrompt);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("offers an upgrade from gpt-5.3-codex to gpt-5.4 when accepted", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omb", "state"), { recursive: true });
      await mkdir(join(wd, ".codebuddy"), { recursive: true });
      await writeFile(
        join(wd, ".codebuddy", "config.toml"),
        'model = \"gpt-5.3-codex\"\n',
      );

      let promptCalls = 0;
      await runSetupInTempDir(wd, {
        scope: "project",
        modelUpgradePrompt: async (currentModel, targetModel) => {
          promptCalls += 1;
          assert.equal(currentModel, "gpt-5.3-codex");
          assert.equal(targetModel, "gpt-5.4");
          return true;
        },
      });

      const config = await readFile(join(wd, ".codebuddy", "config.toml"), "utf-8");
      assert.equal(promptCalls, 1);
      assert.match(config, /^model = "gpt-5\.4"$/m);
      assert.doesNotMatch(config, /^model = "gpt-5\.3-codex"$/m);
      assert.match(config, /^model_context_window = 1000000$/m);
      assert.match(config, /^model_auto_compact_token_limit = 900000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves gpt-5.3-codex when the upgrade prompt is declined", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omb", "state"), { recursive: true });
      await mkdir(join(wd, ".codebuddy"), { recursive: true });
      await writeFile(
        join(wd, ".codebuddy", "config.toml"),
        'model = \"gpt-5.3-codex\"\n',
      );

      await runSetupInTempDir(wd, {
        scope: "project",
        modelUpgradePrompt: async () => false,
      });

      const config = await readFile(join(wd, ".codebuddy", "config.toml"), "utf-8");
      assert.match(config, /^model = "gpt-5\.3-codex"$/m);
      assert.doesNotMatch(config, /^model = "gpt-5\.4"$/m);
      assert.doesNotMatch(config, /^model_context_window = 1000000$/m);
      assert.doesNotMatch(config, /^model_auto_compact_token_limit = 900000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves gpt-5.3-codex in non-interactive runs without prompting", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omb", "state"), { recursive: true });
      await mkdir(join(wd, ".codebuddy"), { recursive: true });
      await writeFile(
        join(wd, ".codebuddy", "config.toml"),
        'model = \"gpt-5.3-codex\"\n',
      );

      await runSetupInTempDir(wd, { scope: "project" });

      const config = await readFile(join(wd, ".codebuddy", "config.toml"), "utf-8");
      assert.match(config, /^model = "gpt-5\.3-codex"$/m);
      assert.doesNotMatch(config, /^model = "gpt-5\.4"$/m);
      assert.doesNotMatch(config, /^model_context_window = 1000000$/m);
      assert.doesNotMatch(config, /^model_auto_compact_token_limit = 900000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("skips OMB-managed [tui] writes for Codex CLI >= 0.107.0 and preserves an existing [tui] table", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omb", "state"), { recursive: true });
      await mkdir(join(wd, ".codebuddy"), { recursive: true });
      await writeFile(
        join(wd, ".codebuddy", "config.toml"),
        ['model = "gpt-5.4"', "", "[tui]", 'theme = "night"', 'status_line = ["git-branch"]', ""].join("\n"),
      );

      const output = await runSetupWithCapturedLogs(wd, {
        scope: "project",
        codexVersionProbe: () => "codex-cli 0.107.0",
      });

      const config = await readFile(join(wd, ".codebuddy", "config.toml"), "utf-8");
      assert.equal(config.match(/^\[tui\]$/gm)?.length ?? 0, 1);
      assert.match(config, /^theme = "night"$/m);
      assert.match(config, /^status_line = \["git-branch"\]$/m);
      assert.match(
        output,
        /Codex CLI >= 0\.107\.0 manages \[tui\]; OMB left that section untouched\./,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps OMB-managed [tui] writes for older Codex CLI versions", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omb", "state"), { recursive: true });

      const output = await runSetupWithCapturedLogs(wd, {
        scope: "project",
        codexVersionProbe: () => "codex-cli 0.106.0",
      });

      const config = await readFile(join(wd, ".codebuddy", "config.toml"), "utf-8");
      assert.match(config, /^\[tui\]$/m);
      assert.match(output, /StatusLine configured in config\.toml via \[tui\] section\./);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("syncs shared MCP registry entries into config.toml during setup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omb", "state"), { recursive: true });
      const registryPath = join(wd, "mcp-registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({
          eslint: { command: "npx", args: ["@eslint/mcp@latest"], timeout: 9 },
        }),
      );

      await runSetupInTempDir(wd, {
        scope: "project",
        mcpRegistryCandidates: [registryPath],
      });

      const config = await readFile(join(wd, ".codebuddy", "config.toml"), "utf-8");
      assert.match(config, /oh-my-codebuddy \(OMB\) Shared MCP Registry Sync/);
      assert.match(config, /^\[mcp_servers\.eslint\]$/m);
      assert.match(config, /^command = "npx"$/m);
      assert.match(config, /^startup_timeout_sec = 9$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it("syncs shared MCP registry entries into ~/.claude/settings.json for user scope", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    const previousHome = process.env.HOME;
    const previousCodebuddyHome = process.env.CODEBUDDY_HOME;
    try {
      process.env.HOME = wd;
      delete process.env.CODEBUDDY_HOME;

      await mkdir(join(wd, ".omb", "state"), { recursive: true });
      await mkdir(join(wd, ".claude"), { recursive: true });
      await writeFile(
        join(wd, ".claude", "settings.json"),
        JSON.stringify(
          {
            uiTheme: "dark",
            mcpServers: {
              existing_server: {
                command: "custom-existing-server",
                args: ["serve"],
                enabled: true,
              },
            },
          },
          null,
          2,
        ),
      );
      const registryPath = join(wd, "mcp-registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({
          existing_server: { command: "existing-server", args: ["mcp"] },
          eslint: { command: "npx", args: ["@eslint/mcp@latest"], enabled: false },
        }),
      );

      await runSetupInTempDir(wd, {
        scope: "user",
        mcpRegistryCandidates: [registryPath],
      });

      const settings = JSON.parse(
        await readFile(join(wd, ".claude", "settings.json"), "utf-8"),
      ) as {
        uiTheme?: string;
        mcpServers?: Record<string, { command: string; args: string[]; enabled: boolean }>;
      };
      assert.equal(settings.uiTheme, "dark");
      assert.deepEqual(settings.mcpServers?.existing_server, {
        command: "custom-existing-server",
        args: ["serve"],
        enabled: true,
      });
      assert.deepEqual(settings.mcpServers?.eslint, {
        command: "npx",
        args: ["@eslint/mcp@latest"],
        enabled: false,
      });
    } finally {
      if (typeof previousHome === "string") process.env.HOME = previousHome;
      else delete process.env.HOME;
      if (typeof previousCodebuddyHome === "string") process.env.CODEBUDDY_HOME = previousCodebuddyHome;
      else delete process.env.CODEBUDDY_HOME;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not write ~/.claude/settings.json during project-scoped setup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    const previousHome = process.env.HOME;
    const previousCodebuddyHome = process.env.CODEBUDDY_HOME;
    try {
      process.env.HOME = wd;
      delete process.env.CODEBUDDY_HOME;

      await mkdir(join(wd, ".omb", "state"), { recursive: true });
      const registryPath = join(wd, "mcp-registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({
          eslint: { command: "npx", args: ["@eslint/mcp@latest"] },
        }),
      );

      await runSetupInTempDir(wd, {
        scope: "project",
        mcpRegistryCandidates: [registryPath],
      });

      assert.equal(existsSync(join(wd, ".claude", "settings.json")), false);
    } finally {
      if (typeof previousHome === "string") process.env.HOME = previousHome;
      else delete process.env.HOME;
      if (typeof previousCodebuddyHome === "string") process.env.CODEBUDDY_HOME = previousCodebuddyHome;
      else delete process.env.CODEBUDDY_HOME;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("ignores legacy ~/.omc/mcp-registry.json during setup unless candidates are passed explicitly", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    const previousHome = process.env.HOME;
    const previousCodebuddyHome = process.env.CODEBUDDY_HOME;
    try {
      process.env.HOME = wd;
      delete process.env.CODEBUDDY_HOME;

      await mkdir(join(wd, ".omb", "state"), { recursive: true });
      await mkdir(join(wd, ".omc"), { recursive: true });
      await writeFile(
        join(wd, ".omc", "mcp-registry.json"),
        JSON.stringify({
          legacy_helper: { command: "legacy-helper", args: ["mcp"] },
        }),
      );

      await runSetupInTempDir(wd, { scope: "project" });

      const config = await readFile(join(wd, ".codebuddy", "config.toml"), "utf-8");
      assert.doesNotMatch(config, /^\[mcp_servers\.legacy_helper\]$/m);
      assert.doesNotMatch(config, /Shared MCP Server: legacy_helper/);

      const output = await runSetupWithCapturedLogs(wd, { scope: "project" });
      assert.match(output, /legacy shared MCP registry detected at .*\.omc\/mcp-registry\.json but ignored by default/i);
      assert.match(output, /move it to .*\.omx\/mcp-registry\.json/i);
    } finally {
      if (typeof previousHome === "string") process.env.HOME = previousHome;
      else delete process.env.HOME;
      if (typeof previousCodebuddyHome === "string") process.env.CODEBUDDY_HOME = previousCodebuddyHome;
      else delete process.env.CODEBUDDY_HOME;
      await rm(wd, { recursive: true, force: true });
    }
  });
});
