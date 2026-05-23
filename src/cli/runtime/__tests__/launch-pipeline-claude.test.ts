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
  });

  it("drops --effort / reasoning-effort for claude (claude has no equivalent flag; -c=continue not -c key=value)", () => {
    // Regression: previously emitted ["-c", 'model_reasoning_effort="high"'],
    // which claude treats as `--continue` and exits 1 — same crash class as
    // the model_instructions_file fix in injectLeaderModelInstructionsBypassArgs.
    assert.deepEqual(
      normalizeLeaderLaunchArgs(["--dangerously-skip-permissions", "--effort", "high"], "claude"),
      ["--dangerously-skip-permissions"],
    );
    assert.deepEqual(
      normalizeLeaderLaunchArgs(["--effort", "xhigh"], "claude"),
      [],
    );
    // legacy --high / --xhigh aliases are also dropped (no -c emitted).
    const fromHigh = normalizeLeaderLaunchArgs(["--high"], "claude");
    assert.equal(fromHigh.includes("-c"), false, "--high must not emit -c for claude");
    const fromXhigh = normalizeLeaderLaunchArgs(["--xhigh"], "claude");
    assert.equal(fromXhigh.includes("-c"), false, "--xhigh must not emit -c for claude");
  });

  it("drops --system-prompt-file for claude (claude auto-reads AGENTS.md/CLAUDE.md from cwd)", () => {
    // Regression: previously emitted ["-c", 'model_instructions_file="..."'],
    // which claude treats as `--continue` and exits 1.
    const fromSpaceForm = normalizeLeaderLaunchArgs(
      ["--system-prompt-file", "/tmp/agents.md"],
      "claude",
    );
    assert.equal(fromSpaceForm.includes("-c"), false, "must not emit -c for claude");
    assert.equal(fromSpaceForm.includes("/tmp/agents.md"), false, "path arg must also be consumed");

    const fromEqualsForm = normalizeLeaderLaunchArgs(
      ["--system-prompt-file=/tmp/agents.md"],
      "claude",
    );
    assert.equal(fromEqualsForm.includes("-c"), false, "must not emit -c for claude (= form)");
    assert.deepEqual(fromEqualsForm, []);
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
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("translates `omb resume` for claude to --resume / --continue (NOT a literal `resume` token)", () => {
    // Bug fixture: previously these returned the leading "resume" verbatim,
    // which claude treated as a prompt literal and echoed into the session.
    assert.deepEqual(
      translateLeaderResumeArgs(["resume"], "claude"),
      ["--resume"],
    );
    assert.deepEqual(
      translateLeaderResumeArgs(["resume", "--last"], "claude"),
      ["--continue"],
    );
    assert.deepEqual(
      translateLeaderResumeArgs(["resume", "session-id-123"], "claude"),
      ["--resume", "session-id-123"],
    );
    // Extra flags after `resume` are preserved.
    assert.deepEqual(
      translateLeaderResumeArgs(["resume", "--last", "-c", "k=v"], "claude"),
      ["--continue", "-c", "k=v"],
    );
    // codex-only flags are stripped with a warning.
    assert.deepEqual(
      translateLeaderResumeArgs(["resume", "--all"], "claude"),
      ["--resume"],
    );
    // Non-resume args are passed through untouched.
    assert.deepEqual(
      translateLeaderResumeArgs(["--print", "hi"], "claude"),
      ["--print", "hi"],
    );
  });

  it("translates `omb exec` for claude to --print (claude has no exec subcommand)", () => {
    // claude uses -p/--print for non-interactive mode, NOT an exec subcommand.
    assert.deepEqual(
      translateLeaderExecArgs(["--json", "say hi"], "claude"),
      ["--print", "--json", "say hi"],
    );
    // If --print is already present, do not duplicate it.
    assert.deepEqual(
      translateLeaderExecArgs(["--print", "say hi"], "claude"),
      ["--print", "say hi"],
    );
    assert.deepEqual(
      translateLeaderExecArgs(["-p", "say hi"], "claude"),
      ["-p", "say hi"],
    );
  });

  it("preserves codex resume/exec subcommands (codex CLI accepts them natively)", () => {
    assert.deepEqual(
      translateLeaderResumeArgs(["resume"], "codex"),
      ["resume"],
    );
    assert.deepEqual(
      translateLeaderResumeArgs(["resume", "--last"], "codex"),
      ["resume", "--last"],
    );
    assert.deepEqual(
      translateLeaderExecArgs(["--json", "say hi"], "codex"),
      ["exec", "--json", "say hi"],
    );
  });
});
