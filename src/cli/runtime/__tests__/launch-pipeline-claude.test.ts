import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildProviderLeaderEnv,
  mirrorLeaderCliIntoProcessEnv,
  normalizeLeaderLaunchArgs,
  parseLeaderCliValue,
  providerHomeEnv,
  resolveCodexHomeForLaunch,
  translateLeaderExecArgs,
  translateLeaderResumeArgs,
} from "../launch-pipeline.js";

describe("Claude leader launch pipeline", () => {
  it("parses Claude leader CLI values and rejects unknown values", () => {
    assert.equal(parseLeaderCliValue("claude", "--leader-cli"), "claude");
    assert.throws(
      () => parseLeaderCliValue("cursor", "--leader-cli"),
      /Expected: codebuddy, codex, claude/,
    );
  });

  it("builds Claude provider home env while clearing opposite providers", () => {
    assert.deepEqual(providerHomeEnv("/tmp/claude-home", "claude"), {
      OMB_LEADER_CLI: "claude",
      CLAUDE_HOME: "/tmp/claude-home",
      CODEBUDDY_HOME: "",
      CODEX_HOME: "",
    });

    const env = buildProviderLeaderEnv(
      {
        CODEBUDDY_HOME: "/tmp/codebuddy",
        CODEX_HOME: "/tmp/codex",
        CLAUDE_HOME: "/tmp/old-claude",
        KEEP_ME: "1",
      },
      "claude",
      "/tmp/claude-home",
    );
    assert.equal(env.OMB_LEADER_CLI, "claude");
    assert.equal(env.CLAUDE_HOME, "/tmp/claude-home");
    assert.equal(env.CODEBUDDY_HOME, undefined);
    assert.equal(env.CODEX_HOME, undefined);
    assert.equal(env.KEEP_ME, "1");
  });

  it("mirrors Claude leader CLI into same-process env", () => {
    const env: NodeJS.ProcessEnv = {};
    mirrorLeaderCliIntoProcessEnv("claude", env);
    assert.equal(env.OMB_LEADER_CLI, "claude");
  });

  it("normalizes Claude bypass aliases to the supported skip-permissions flag", () => {
    assert.deepEqual(normalizeLeaderLaunchArgs(["--madmax"], "claude"), ["--dangerously-skip-permissions"]);
    assert.deepEqual(
      normalizeLeaderLaunchArgs(["--dangerously-bypass-approvals-and-sandbox"], "claude"),
      ["--dangerously-skip-permissions"],
    );
    assert.deepEqual(
      normalizeLeaderLaunchArgs(["--dangerously-skip-permissions", "--effort", "high"], "claude"),
      ["--dangerously-skip-permissions", "-c", 'model_reasoning_effort="high"'],
    );
  });

  it("resolves project-scoped .claude home and treats exec/resume as Codex-like", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-claude-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project", provider: "claude" }),
      );
      assert.equal(resolveCodexHomeForLaunch(wd, {}, "claude"), join(wd, ".claude"));
      assert.equal(
        resolveCodexHomeForLaunch(wd, { CLAUDE_HOME: "/tmp/explicit-claude" }, "claude"),
        "/tmp/explicit-claude",
      );
      assert.deepEqual(translateLeaderResumeArgs(["resume", "--last"], "claude"), ["resume", "--last"]);
      assert.deepEqual(translateLeaderExecArgs(["--json", "say hi"], "claude"), ["exec", "--json", "say hi"]);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
