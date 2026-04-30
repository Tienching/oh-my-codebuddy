import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAutoresearchLeaderEnv,
  parseAutoresearchArgs,
  resolveAutoresearchLeaderHomeEnv,
} from "../autoresearch.js";

describe("autoresearch Claude leader CLI", () => {
  it("parses --leader-cli claude without forwarding selector flags", () => {
    const parsed = parseAutoresearchArgs(
      ["--leader-cli", "claude", "run", "missions/demo", "--model", "sonnet"],
      {},
    );
    assert.equal(parsed.leaderCli, "claude");
    assert.equal(parsed.missionDir, "missions/demo");
    assert.deepEqual(parsed.codebuddyArgs, ["--model", "sonnet"]);
  });

  it("sets CLAUDE_HOME and scrubs opposite provider homes for child turns", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-autoresearch-claude-env-"));
    try {
      const claudeHome = join(wd, ".claude");
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(join(wd, ".omb", "setup-scope.json"), JSON.stringify({ scope: "project", provider: "claude" }));

      const homeEnv = resolveAutoresearchLeaderHomeEnv("claude", wd, {
        CLAUDE_HOME: claudeHome,
        CODEBUDDY_HOME: "/tmp/codebuddy",
        CODEX_HOME: "/tmp/codex",
      });
      assert.deepEqual(homeEnv, {
        CLAUDE_HOME: claudeHome,
        CODEBUDDY_HOME: "",
        CODEX_HOME: "",
      });

      const launchEnv = buildAutoresearchLeaderEnv("claude", wd, {
        CLAUDE_HOME: claudeHome,
        CODEBUDDY_HOME: "/tmp/codebuddy",
        CODEX_HOME: "/tmp/codex",
        PATH: "/usr/bin:/bin",
      });
      assert.equal(launchEnv.OMB_LEADER_CLI, "claude");
      assert.equal(launchEnv.CLAUDE_HOME, claudeHome);
      assert.equal(launchEnv.CODEBUDDY_HOME, undefined);
      assert.equal(launchEnv.CODEX_HOME, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
