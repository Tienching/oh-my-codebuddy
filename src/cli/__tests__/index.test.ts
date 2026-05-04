import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir as fsReaddir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeCodexLaunchArgs,
  normalizeCodexCliLaunchArgs,
  normalizeLeaderLaunchArgs,
  buildTmuxShellCommand,
  buildTmuxPaneCommand,
  buildWindowsPromptCommand,
  buildTmuxSessionName,
  resolveCliInvocation,
  commandOwnsLocalHelp,
  resolveCommandTemplateLaunchPrompt,
  resolveCodexLaunchPolicy,
  resolveLeaderLaunchPolicyOverride,
  classifyCodexExecFailure,
  resolveSignalExitCode,
  parseTmuxPaneSnapshot,
  findHudWatchPaneIds,
  buildHudPaneCleanupTargets,
  readTopLevelTomlString,
  upsertTopLevelTomlString,
  collectInheritableTeamWorkerArgs,
  resolveTeamWorkerLaunchArgsEnv,
  extractLeaderCliArgs,
  injectModelInstructionsBypassArgs,
  injectLeaderModelInstructionsBypassArgs,
  translateLeaderExecArgs,
  translateLeaderResumeArgs,
  translateCodeBuddyExecArgs,
  translateCodeBuddyResumeArgs,
  resolveWorkerSparkModel,
  resolveSetupScopeArg,
  resolveSetupProviderArg,
  readPersistedSetupPreferences,
  readPersistedSetupScope,
  resolveCodexHomeForLaunch,
  buildDetachedSessionBootstrapSteps,
  buildDetachedTmuxSessionName,
  buildDetachedSessionFinalizeSteps,
  buildDetachedSessionRollbackSteps,
  resolveNotifyTempContract,
  buildNotifyTempStartupMessages,
  buildNotifyFallbackWatcherEnv,
  shouldEnableNotifyFallbackWatcher,
  reapStaleNotifyFallbackWatcher,
  cleanupLaunchOrphanedMcpProcesses,
  reapPostLaunchOrphanedMcpProcesses,
  cleanupPostLaunchModeStateFiles,
  resolveBackgroundHelperLaunchMode,
  mirrorLeaderCliIntoProcessEnv,
  shouldDetachBackgroundHelper,
  resolveNotifyFallbackWatcherScript,
  resolveHookDerivedWatcherScript,
  resolveNotifyHookScript,
  acquireTmuxExtendedKeysLease,
  releaseTmuxExtendedKeysLease,
  withTmuxExtendedKeys,
} from "../index.js";
import { HUD_TMUX_HEIGHT_LINES } from "../../hud/constants.js";
import {
  DEFAULT_FRONTIER_MODEL,
  getTeamLowComplexityModel,
} from "../../config/models.js";
import type { ProcessEntry } from "../cleanup.js";

function expectedLowComplexityModel(codebuddyHomeOverride?: string): string {
  return getTeamLowComplexityModel(codebuddyHomeOverride);
}

describe("normalizeCodexLaunchArgs", () => {
  it("maps --madmax to CodeBuddy bypass flag", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--madmax"]), [
      "--dangerously-skip-permissions",
    ]);
  });

  it("maps --yolo to CodeBuddy bypass flag", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--yolo"]), [
      "--dangerously-skip-permissions",
    ]);
  });

  it("does not forward bypass shorthands and preserves other args", () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(["--model", "gpt-5", "--madmax", "--yolo"]),
      [
        "--model",
        "gpt-5",
        "--dangerously-skip-permissions",
      ],
    );
  });

  it("avoids duplicate bypass flags when both are present", () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs([
        "--dangerously-skip-permissions",
        "--madmax",
      ]),
      ["--dangerously-skip-permissions"],
    );
  });

  it("deduplicates repeated bypass-related flags", () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs([
        "--madmax",
        "--dangerously-skip-permissions",
        "--madmax",
        "--dangerously-skip-permissions",
      ]),
      ["--dangerously-skip-permissions"],
    );
  });

  it("leaves unrelated args unchanged", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--model", "gpt-5", "--yolo"]), [
      "--model",
      "gpt-5",
      "--dangerously-skip-permissions",
    ]);
  });

  it("maps --high to CodeBuddy effort", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--high"]), [
      "--effort",
      "high",
    ]);
  });

  it("maps --xhigh to CodeBuddy effort", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--xhigh"]), [
      "--effort",
      "xhigh",
    ]);
  });

  it("uses the last reasoning shorthand when both are present", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--high", "--xhigh"]), [
      "--effort",
      "xhigh",
    ]);
  });

  it("maps --xhigh --madmax to CodeBuddy-native flags only", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--xhigh", "--madmax"]), [
      "--dangerously-skip-permissions",
      "--effort",
      "xhigh",
    ]);
  });

  it("maps --effort low to CodeBuddy effort flag", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--effort", "low"]), [
      "--effort",
      "low",
    ]);
  });

  it("maps --effort medium to CodeBuddy effort flag", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--effort", "medium"]), [
      "--effort",
      "medium",
    ]);
  });

  it("maps --effort high to CodeBuddy effort flag", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--effort", "high"]), [
      "--effort",
      "high",
    ]);
  });

  it("maps --effort xhigh to CodeBuddy effort flag", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--effort", "xhigh"]), [
      "--effort",
      "xhigh",
    ]);
  });

  it("--high emits deprecation warning to stderr", () => {
    const origWrite = process.stderr.write;
    const chunks: string[] = [];
    process.stderr.write = (chunk: string | Buffer) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      normalizeCodexLaunchArgs(["--high"]);
      const output = chunks.join("");
      assert.ok(output.includes("deprecated"), `expected deprecation warning, got: ${output}`);
      assert.ok(output.includes("--effort high"), `expected direct --effort migration hint, got: ${output}`);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("--xhigh emits deprecation warning to stderr", () => {
    const origWrite = process.stderr.write;
    const chunks: string[] = [];
    process.stderr.write = (chunk: string | Buffer) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      normalizeCodexLaunchArgs(["--xhigh"]);
      const output = chunks.join("");
      assert.ok(output.includes("deprecated"), `expected deprecation warning, got: ${output}`);
      assert.ok(output.includes("--effort xhigh"), `expected direct --effort migration hint, got: ${output}`);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("translates Codex config shorthands into CodeBuddy system prompt and effort flags", () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs([
        "-c",
        'model_instructions_file="/tmp/custom-agents.md"',
        "--config=model_reasoning_effort=\"high\"",
      ]),
      [
        "--system-prompt-file",
        "/tmp/custom-agents.md",
        "--effort",
        "high",
      ],
    );
  });

  it("drops unsupported Codex config overrides so CodeBuddy does not treat -c as continue", () => {
    const origWrite = process.stderr.write;
    process.stderr.write = () => true;
    try {
      assert.deepEqual(
        normalizeCodexLaunchArgs(["-c", 'sandbox_permissions=["danger-full-access"]', "--model", "gpt-5"]),
        ["--model", "gpt-5"],
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("maps Codex approval never to CodeBuddy bypass permissions", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--ask-for-approval", "never"]), [
      "--dangerously-skip-permissions",
    ]);
  });

  it("preserves explicit CodeBuddy permission mode and avoids duplicate bypass flag", () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs([
        "--madmax",
        "--permission-mode",
        "bypassPermissions",
      ]),
      ["--permission-mode", "bypassPermissions"],
    );
  });

  it("--spark is stripped from leader args (model goes to workers only)", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--spark", "--yolo"]), [
      "--dangerously-skip-permissions",
    ]);
  });

  it("--spark alone produces no leader args", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--spark"]), []);
  });

  it("--madmax-spark adds bypass flag to leader args and is otherwise consumed", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--madmax-spark"]), [
      "--dangerously-skip-permissions",
    ]);
  });

  it("--madmax-spark deduplicates bypass when --madmax also present", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--madmax", "--madmax-spark"]), [
      "--dangerously-skip-permissions",
    ]);
  });

  it("--madmax-spark does not inject spark model into leader args", () => {
    const args = normalizeCodexLaunchArgs(["--madmax-spark"]);
    assert.ok(
      !args.includes("--model"),
      "leader args must not contain --model from --madmax-spark",
    );
    assert.ok(
      !args.some((a) => a.includes("spark")),
      "leader args must not reference spark model",
    );
  });

  it("strips detached worktree flag from leader codex args", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--worktree", "--yolo"]), [
      "--dangerously-skip-permissions",
    ]);
  });

  it("strips named worktree flag from leader codex args", () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(["--worktree=feature/demo", "--model", "gpt-5"]),
      ["--model", "gpt-5"],
    );
  });

  it("does not forward notify-temp flags/selectors to leader codex args", () => {
    const parsed = resolveNotifyTempContract(
      [
        "--notify-temp",
        "--discord",
        "--custom",
        "openclaw:ops",
        "--custom=my-hook",
        "--model",
        "gpt-5",
      ],
      {},
    );
    assert.deepEqual(normalizeCodexLaunchArgs(parsed.passthroughArgs), [
      "--model",
      "gpt-5",
    ]);
  });

  it("strips --tmux from leader codex args", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--tmux", "--yolo"]), [
      "--dangerously-skip-permissions",
    ]);
  });

  it("preserves literal --tmux after -- in leader codex args", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--", "--tmux", "--yolo"]), [
      "--",
      "--tmux",
      "--dangerously-skip-permissions",
    ]);
  });
});

describe("leader CLI selection", () => {
  it("defaults to CodeBuddy and strips leader CLI selector flags from leader args", () => {
    assert.deepEqual(extractLeaderCliArgs(["--model", "gpt-5"], {}), {
      leaderCli: "codebuddy",
      remainingArgs: ["--model", "gpt-5"],
    });
    assert.deepEqual(extractLeaderCliArgs(["--leader-cli", "codex", "--model", "gpt-5"], {}), {
      leaderCli: "codex",
      remainingArgs: ["--model", "gpt-5"],
    });
    assert.deepEqual(extractLeaderCliArgs(["--cli", "codex", "--model", "gpt-5"], {}), {
      leaderCli: "codex",
      remainingArgs: ["--model", "gpt-5"],
    });
    assert.deepEqual(extractLeaderCliArgs(["--leader-cli=codex", "--yolo"], {}), {
      leaderCli: "codex",
      remainingArgs: ["--yolo"],
    });
    assert.deepEqual(extractLeaderCliArgs(["--leader-cli", "claude", "--model", "sonnet"], {}), {
      leaderCli: "claude",
      remainingArgs: ["--model", "sonnet"],
    });
    assert.deepEqual(extractLeaderCliArgs(["--cli=codebuddy", "--yolo"], { OMB_LEADER_CLI: "codex" }), {
      leaderCli: "codebuddy",
      remainingArgs: ["--yolo"],
    });
  });

  it("normalizes Codex leader args back to Codex-native flags", () => {
    assert.deepEqual(
      normalizeCodexCliLaunchArgs(["--madmax", "--effort", "high", "--system-prompt-file", "/tmp/AGENTS.md"]),
      [
        "-c",
        'model_instructions_file="/tmp/AGENTS.md"',
        "--dangerously-bypass-approvals-and-sandbox",
        "-c",
        'model_reasoning_effort="high"',
      ],
    );
  });

  it("dispatches normalization by selected leader CLI", () => {
    assert.deepEqual(normalizeLeaderLaunchArgs(["--madmax"], "codebuddy"), ["--dangerously-skip-permissions"]);
    assert.deepEqual(normalizeLeaderLaunchArgs(["--madmax"], "codex"), ["--dangerously-bypass-approvals-and-sandbox"]);
    assert.deepEqual(normalizeLeaderLaunchArgs(["--madmax"], "claude"), ["--dangerously-bypass-approvals-and-sandbox"]);
  });

  it("preserves Codex resume and exec subcommands while translating CodeBuddy", () => {
    assert.deepEqual(
      translateLeaderResumeArgs(["resume", "--last"], "codex"),
      ["resume", "--last"],
    );
    assert.deepEqual(
      translateLeaderResumeArgs(["resume", "--last"], "codebuddy"),
      ["--continue"],
    );
    assert.deepEqual(
      translateLeaderExecArgs(["--json", "say hi"], "codex"),
      ["exec", "--json", "say hi"],
    );
    assert.deepEqual(
      translateLeaderResumeArgs(["resume", "--last"], "claude"),
      ["resume", "--last"],
    );
    assert.deepEqual(
      translateLeaderExecArgs(["--json", "say hi"], "claude"),
      ["exec", "--json", "say hi"],
    );
    assert.deepEqual(
      translateLeaderExecArgs(["--json", "say hi"], "codebuddy"),
      ["--print", "--output-format", "stream-json", "say hi"],
    );
  });
});

describe("translateCodeBuddyResumeArgs", () => {
  it("maps omb resume --last to CodeBuddy continue flag", () => {
    assert.deepEqual(
      translateCodeBuddyResumeArgs(["resume", "--last", "--effort", "high"]),
      ["--continue", "--effort", "high"],
    );
  });

  it("maps omb resume session id to CodeBuddy resume flag", () => {
    assert.deepEqual(
      translateCodeBuddyResumeArgs(["resume", "session-123", "--effort", "high"]),
      ["--resume", "session-123", "--effort", "high"],
    );
  });
});

describe("translateCodeBuddyExecArgs", () => {
  it("uses CodeBuddy --print instead of Codex exec subcommand", () => {
    assert.deepEqual(
      translateCodeBuddyExecArgs(["--model", "gpt-5", "say hi"]),
      ["--print", "--model", "gpt-5", "say hi"],
    );
  });

  it("maps Codex exec JSON flags to CodeBuddy print output flags", () => {
    assert.deepEqual(
      translateCodeBuddyExecArgs(["--json", "--output-schema", "schema.json", "say hi"]),
      ["--print", "--output-format", "stream-json", "--json-schema", "schema.json", "say hi"],
    );
  });
});

describe("resolveLeaderLaunchPolicyOverride", () => {
  it("detects explicit detached tmux launch requests", () => {
    assert.equal(
      resolveLeaderLaunchPolicyOverride(["--tmux", "--model", "gpt-5"]),
      "detached-tmux",
    );
  });

  it("returns undefined when no explicit policy override is present", () => {
    assert.equal(
      resolveLeaderLaunchPolicyOverride(["--model", "gpt-5"]),
      undefined,
    );
  });

  it("stops scanning for --tmux after the end-of-options marker", () => {
    assert.equal(
      resolveLeaderLaunchPolicyOverride(["--", "--tmux", "--model", "gpt-5"]),
      undefined,
    );
  });
});

describe("resolveNotifyTempContract", () => {
  it("activates from --notify-temp with no providers", () => {
    const parsed = resolveNotifyTempContract(
      ["--notify-temp", "--model", "gpt-5"],
      {},
    );
    assert.equal(parsed.contract.active, true);
    assert.equal(parsed.contract.source, "cli");
    assert.deepEqual(parsed.contract.canonicalSelectors, []);
    assert.deepEqual(parsed.passthroughArgs, ["--model", "gpt-5"]);
  });

  it("auto-activates when provider selectors are present", () => {
    const parsed = resolveNotifyTempContract(["--discord", "--slack"], {});
    assert.equal(parsed.contract.active, true);
    assert.equal(parsed.contract.source, "providers");
    assert.deepEqual(parsed.contract.canonicalSelectors, ["discord", "slack"]);
    assert.equal(
      parsed.contract.warnings.some((line) => line.includes("imply temp mode")),
      true,
    );
  });

  it("supports repeated --custom forms and canonicalizes selectors", () => {
    const parsed = resolveNotifyTempContract(
      ["--custom", "OpenClaw:Ops", "--custom=my-hook", "--custom=", "--custom"],
      {},
    );
    assert.deepEqual(parsed.contract.canonicalSelectors, [
      "openclaw:ops",
      "custom:my-hook",
    ]);
    assert.equal(parsed.contract.warnings.length >= 1, true);
  });

  it("activates from OMB_NOTIFY_TEMP=1 env parity", () => {
    const parsed = resolveNotifyTempContract(["--model", "gpt-5"], {
      OMB_NOTIFY_TEMP: "1",
    });
    assert.equal(parsed.contract.active, true);
    assert.equal(parsed.contract.source, "env");
    assert.deepEqual(parsed.passthroughArgs, ["--model", "gpt-5"]);
  });
});

describe("cleanupLaunchOrphanedMcpProcesses", () => {
  it("reaps only detached OMB MCP processes without a live Codex ancestor", async () => {
    const processes: ProcessEntry[] = [
      { pid: 700, ppid: 500, command: "codex" },
      { pid: 701, ppid: 700, command: "node /repo/bin/omb.js" },
      {
        pid: 710,
        ppid: 700,
        command: "node /repo/oh-my-codebuddy/dist/mcp/state-server.js",
      },
      {
        pid: 800,
        ppid: 1,
        command: "node /tmp/oh-my-codebuddy/dist/mcp/memory-server.js",
      },
      {
        pid: 810,
        ppid: 42,
        command: "node /tmp/oh-my-codebuddy/dist/mcp/trace-server.js",
      },
      {
        pid: 820,
        ppid: 50,
        command: "codex --model gpt-5",
      },
      {
        pid: 821,
        ppid: 820,
        command: "node /tmp/other-session/dist/mcp/state-server.js",
      },
      {
        pid: 830,
        ppid: 50,
        command: "node /repo/bin/omb.js autoresearch --topic launch",
      },
      {
        pid: 831,
        ppid: 830,
        command: "node /tmp/parallel-session/dist/mcp/memory-server.js",
      },
    ];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const alive = new Set([800, 810]);

    const result = await cleanupLaunchOrphanedMcpProcesses({
      currentPid: 701,
      listProcesses: () => processes,
      isPidAlive: (pid) => alive.has(pid),
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
        alive.delete(pid);
      },
      sleep: async () => {},
      now: () => 0,
    });

    assert.equal(result.terminatedCount, 2);
    assert.equal(result.forceKilledCount, 0);
    assert.deepEqual(result.failedPids, []);
    assert.deepEqual(signals, [
      { pid: 800, signal: "SIGTERM" },
      { pid: 810, signal: "SIGTERM" },
    ]);
    assert.equal(
      signals.some(({ pid }) => pid === 821),
      false,
      "launch-safe cleanup must preserve OMB MCP processes still attached to another live Codex tree",
    );
    assert.equal(
      signals.some(({ pid }) => pid === 831),
      false,
      "launch-safe cleanup must preserve OMB MCP processes still attached to another live OMB launch tree",
    );
  });
});

describe("reapPostLaunchOrphanedMcpProcesses", () => {
  it("logs postLaunch reaped MCP orphans and keeps cleanup non-fatal", async () => {
    const info: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    await reapPostLaunchOrphanedMcpProcesses({
      cleanup: async () => ({
        dryRun: false,
        candidates: [],
        terminatedCount: 2,
        forceKilledCount: 0,
        failedPids: [810],
      }),
      writeInfo: (line) => info.push(line),
      writeWarn: (line) => warnings.push(line),
      writeError: (line) => errors.push(line),
    });

    assert.deepEqual(errors, []);
    assert.match(
      info.join("\n"),
      /postLaunch: reaped 2 orphaned OMB MCP process/,
    );
    assert.match(
      warnings.join("\n"),
      /postLaunch: failed to reap 1 orphaned OMB MCP process/,
    );
  });

  it("writes a non-fatal postLaunch cleanup error when the cleanup step throws", async () => {
    const errors: string[] = [];

    await reapPostLaunchOrphanedMcpProcesses({
      cleanup: async () => {
        throw new Error("boom");
      },
      writeError: (line) => errors.push(line),
    });

    assert.match(errors.join("\n"), /postLaunch MCP cleanup failed: Error: boom/);
  });
});

describe("cleanupPostLaunchModeStateFiles", () => {
  it("repairs empty or truncated mode state files and still cancels valid siblings", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-postlaunch-mode-cleanup-"));
    const sessionId = "sess-postlaunch-cleanup";
    const stateDir = join(wd, ".omb", "state");
    const sessionStateDir = join(stateDir, "sessions", sessionId);
    const partialState = '{\n  "active": true,\n  "mode": "ralph",\n';
    const warnings: string[] = [];

    await mkdir(sessionStateDir, { recursive: true });
    await writeFile(
      join(stateDir, "autopilot-state.json"),
      JSON.stringify({ active: true, mode: "autopilot" }, null, 2),
      "utf-8",
    );
    await writeFile(join(stateDir, "deep-interview-state.json"), "", "utf-8");
    await writeFile(join(sessionStateDir, "ralph-state.json"), partialState, "utf-8");

    await cleanupPostLaunchModeStateFiles(wd, sessionId, {
      writeWarn: (line) => warnings.push(line),
    });

    const autopilot = JSON.parse(
      await readFile(join(stateDir, "autopilot-state.json"), "utf-8"),
    ) as Record<string, unknown>;
    const deepInterview = JSON.parse(
      await readFile(join(stateDir, "deep-interview-state.json"), "utf-8"),
    ) as Record<string, unknown>;
    const ralph = JSON.parse(
      await readFile(join(sessionStateDir, "ralph-state.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert.equal(autopilot.active, false);
    assert.equal(typeof autopilot.completed_at, "string");
    assert.equal(deepInterview.active, false);
    assert.equal(deepInterview.mode, "deep-interview");
    assert.equal(deepInterview.current_phase, "cancelled");
    assert.equal(typeof deepInterview.completed_at, "string");
    assert.equal(typeof deepInterview.last_turn_at, "string");
    assert.equal(ralph.active, false);
    assert.equal(ralph.mode, "ralph");
    assert.equal(ralph.current_phase, "cancelled");
    assert.equal(typeof ralph.completed_at, "string");
    assert.equal(typeof ralph.last_turn_at, "string");
    assert.deepEqual(warnings, []);
  });

  it("retries a transient parse failure before cancelling the rewritten mode state", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-postlaunch-mode-retry-"));
    const sessionId = "sess-postlaunch-retry";
    const stateDir = join(wd, ".omb", "state");
    const statePath = join(stateDir, "ralph-state.json");
    const writes: Array<{ path: string; content: string }> = [];
    const validState = JSON.stringify({ active: true, mode: "ralph" }, null, 2);
    let reads = 0;

    await mkdir(stateDir, { recursive: true });

    const mockReaddir = (async (dir: unknown, _options: unknown) => (
      String(dir) === stateDir ? ["ralph-state.json"] : []
    )) as unknown as typeof fsReaddir;
    const mockReadFile = (async (path: unknown, _options: unknown) => {
        assert.equal(String(path), statePath);
        reads += 1;
        return reads === 1
          ? '{\n  "active": true,\n  "mode": "ralph"'
          : validState;
      }) as unknown as typeof readFile;
    const mockWriteFile = (async (path: unknown, content: unknown, _options: unknown) => {
        writes.push({ path: String(path), content: String(content) });
      }) as unknown as typeof writeFile;

    const dependencies: Parameters<typeof cleanupPostLaunchModeStateFiles>[2] = {
      readdir: mockReaddir,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      sleep: async () => {},
      now: () => new Date("2026-04-07T00:00:00.000Z"),
    };

    await cleanupPostLaunchModeStateFiles(wd, sessionId, dependencies);

    assert.equal(reads, 2);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.path, statePath);
    const persisted = JSON.parse(writes[0]?.content ?? "{}") as Record<string, unknown>;
    assert.equal(persisted.active, false);
    assert.equal(persisted.completed_at, "2026-04-07T00:00:00.000Z");
  });

  it("warns on structurally complete malformed JSON without aborting sibling cleanup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-postlaunch-mode-malformed-"));
    const sessionId = "sess-postlaunch-malformed";
    const stateDir = join(wd, ".omb", "state");
    const warnings: string[] = [];
    const malformedState = '{\n  "active": true,\n}\n';

    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "ralph-state.json"), malformedState, "utf-8");
    await writeFile(
      join(stateDir, "ultrawork-state.json"),
      JSON.stringify({ active: true, mode: "ultrawork" }, null, 2),
      "utf-8",
    );

    await cleanupPostLaunchModeStateFiles(wd, sessionId, {
      writeWarn: (line) => warnings.push(line),
    });

    const ultrawork = JSON.parse(
      await readFile(join(stateDir, "ultrawork-state.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert.equal(ultrawork.active, false);
    assert.equal(typeof ultrawork.completed_at, "string");
    assert.equal(await readFile(join(stateDir, "ralph-state.json"), "utf-8"), malformedState);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /skipped malformed mode state .*ralph-state\.json/);
  });
});

describe("watcher script path resolution", () => {
  it("resolves packaged watcher entrypoints from dist/scripts", () => {
    assert.equal(
      resolveNotifyFallbackWatcherScript("/pkg"),
      "/pkg/dist/scripts/notify-fallback-watcher.js",
    );
    assert.equal(
      resolveHookDerivedWatcherScript("/pkg"),
      "/pkg/dist/scripts/hook-derived-watcher.js",
    );
    assert.equal(
      resolveNotifyHookScript("/pkg"),
      "/pkg/dist/scripts/notify-hook.js",
    );
  });
});

describe("buildNotifyFallbackWatcherEnv", () => {
  it("enables watcher authority and propagates CODEBUDDY_HOME override when requested", () => {
    const env = buildNotifyFallbackWatcherEnv(
      { HOME: "/tmp/home", OMB_HUD_AUTHORITY: "0", TMUX: "sock,1,0", TMUX_PANE: "%2" },
      { codexHomeOverride: "/tmp/codebuddy-home", enableAuthority: true },
    );
    assert.equal(env.OMB_HUD_AUTHORITY, "1");
    assert.equal(env.CODEBUDDY_HOME, "/tmp/codebuddy-home");
    assert.equal(env.CODEX_HOME, undefined);
    assert.equal(env.OMB_LEADER_CLI, "codebuddy");
    assert.equal(env.HOME, "/tmp/home");
    assert.equal(env.TMUX, undefined);
    assert.equal(env.TMUX_PANE, undefined);
  });

  it("propagates CODEX_HOME override only for codex watcher sessions", () => {
    const env = buildNotifyFallbackWatcherEnv(
      {
        HOME: "/tmp/home",
        OMB_HUD_AUTHORITY: "0",
        TMUX: "sock,1,0",
        TMUX_PANE: "%2",
        CODEBUDDY_HOME: "/leaked/codebuddy-home",
      },
      { codexHomeOverride: "/tmp/codex-home", enableAuthority: true, leaderCli: "codex" },
    );
    assert.equal(env.OMB_HUD_AUTHORITY, "1");
    // Opposite-provider home must be scrubbed so a Codex leader session can't
    // inherit an ambient CodeBuddy home from the parent process env.
    assert.equal(env.CODEBUDDY_HOME, undefined);
    assert.equal(env.CODEX_HOME, "/tmp/codex-home");
    assert.equal(env.OMB_LEADER_CLI, "codex");
    assert.equal(env.HOME, "/tmp/home");
    assert.equal(env.TMUX, undefined);
    assert.equal(env.TMUX_PANE, undefined);
  });

  it("propagates CLAUDE_HOME override only for Claude watcher sessions", () => {
    const env = buildNotifyFallbackWatcherEnv(
      {
        HOME: "/tmp/home",
        OMB_HUD_AUTHORITY: "0",
        TMUX: "sock,1,0",
        TMUX_PANE: "%2",
        CODEBUDDY_HOME: "/leaked/codebuddy-home",
        CODEX_HOME: "/leaked/codex-home",
      },
      { codexHomeOverride: "/tmp/claude-home", enableAuthority: true, leaderCli: "claude" },
    );
    assert.equal(env.OMB_HUD_AUTHORITY, "1");
    assert.equal(env.CODEBUDDY_HOME, undefined);
    assert.equal(env.CODEX_HOME, undefined);
    assert.equal(env.CLAUDE_HOME, "/tmp/claude-home");
    assert.equal(env.OMB_LEADER_CLI, "claude");
    assert.equal(env.HOME, "/tmp/home");
    assert.equal(env.TMUX, undefined);
    assert.equal(env.TMUX_PANE, undefined);
  });

  it("disables watcher authority explicitly when not requested", () => {
    const env = buildNotifyFallbackWatcherEnv(
      { HOME: "/tmp/home", OMB_HUD_AUTHORITY: "1", TMUX: "sock,1,0", TMUX_PANE: "%3" },
      { enableAuthority: false },
    );
    assert.equal(env.OMB_HUD_AUTHORITY, "0");
    assert.equal(env.HOME, "/tmp/home");
    assert.equal(env.TMUX, undefined);
    assert.equal(env.TMUX_PANE, undefined);
  });
});

describe("mirrorLeaderCliIntoProcessEnv", () => {
  it("publishes the resolved leader CLI into the supplied env so ambient readers agree", () => {
    // Same-process consumers (agents-overlay.resolveSessionUserHome, worker
    // bootstrap) read ambient OMB_LEADER_CLI. When --leader-cli arrives via
    // argv, the leader process must mirror the resolved value into its env.
    const env: NodeJS.ProcessEnv = { HOME: "/tmp/home" };
    mirrorLeaderCliIntoProcessEnv("codex", env);
    assert.equal(env.OMB_LEADER_CLI, "codex");
    mirrorLeaderCliIntoProcessEnv("claude", env);
    assert.equal(env.OMB_LEADER_CLI, "claude");
    mirrorLeaderCliIntoProcessEnv("codebuddy", env);
    assert.equal(env.OMB_LEADER_CLI, "codebuddy");
  });

  it("leaves provider home env untouched so callers can keep an explicit CODEBUDDY_HOME/CODEX_HOME override", () => {
    const env: NodeJS.ProcessEnv = {
      CODEBUDDY_HOME: "/home/user/.codebuddy",
      CODEX_HOME: "/home/user/.codex",
    };
    mirrorLeaderCliIntoProcessEnv("codex", env);
    assert.equal(env.CODEBUDDY_HOME, "/home/user/.codebuddy");
    assert.equal(env.CODEX_HOME, "/home/user/.codex");
    assert.equal(env.OMB_LEADER_CLI, "codex");
  });
});

describe("shouldEnableNotifyFallbackWatcher", () => {
  it("keeps notify fallback enabled by default on non-Windows hosts", () => {
    assert.equal(shouldEnableNotifyFallbackWatcher({}, "linux"), true);
  });

  it("disables notify fallback explicitly on non-Windows hosts", () => {
    assert.equal(
      shouldEnableNotifyFallbackWatcher({ OMB_NOTIFY_FALLBACK: "0" }, "linux"),
      false,
    );
  });

  it("disables notify fallback by default on win32", () => {
    assert.equal(shouldEnableNotifyFallbackWatcher({}, "win32"), false);
  });

  it("allows explicit opt-in for notify fallback on win32", () => {
    assert.equal(
      shouldEnableNotifyFallbackWatcher({ OMB_NOTIFY_FALLBACK: "1" }, "win32"),
      true,
    );
  });
});

describe("reapStaleNotifyFallbackWatcher", () => {
  it("stops an existing watcher even when a later startup gate would skip relaunch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-stale-notify-fallback-"));
    try {
      const pidPath = join(cwd, "notify-fallback.pid");
      await writeFile(
        pidPath,
        JSON.stringify({ pid: 4321, started_at: "2026-04-05T00:00:00.000Z" }),
        "utf-8",
      );
      const killed: Array<{ pid: number; signal?: NodeJS.Signals }> = [];

      await reapStaleNotifyFallbackWatcher(pidPath, {
        tryKillPid(pid, signal) {
          killed.push({ pid, signal });
          return true;
        },
      });

      assert.deepEqual(killed, [{ pid: 4321, signal: "SIGTERM" }]);
      assert.equal(shouldEnableNotifyFallbackWatcher({}, "win32"), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ignores missing pid files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-missing-notify-fallback-"));
    try {
      const pidPath = join(cwd, "notify-fallback.pid");
      let killCalls = 0;

      await reapStaleNotifyFallbackWatcher(pidPath, {
        tryKillPid() {
          killCalls += 1;
          return true;
        },
      });

      assert.equal(killCalls, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses ESRCH cleanup errors but warns on unexpected failures", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-esrch-notify-fallback-"));
    try {
      const pidPath = join(cwd, "notify-fallback.pid");
      await writeFile(pidPath, JSON.stringify({ pid: 99 }), "utf-8");

      const warnings: Array<{ message: unknown; meta: unknown }> = [];
      await reapStaleNotifyFallbackWatcher(pidPath, {
        readFile: async () => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        },
        warn(message, meta) {
          warnings.push({ message, meta });
        },
      });
      assert.deepEqual(warnings, []);

      const warned: Array<{ message: unknown; meta: unknown }> = [];
      await reapStaleNotifyFallbackWatcher(pidPath, {
        readFile: async (path, encoding) => readFile(path, encoding),
        tryKillPid() {
          throw new Error("permission denied");
        },
        warn(message, meta) {
          warned.push({ message, meta });
        },
      });
      assert.equal(warned.length, 1);
      assert.equal(warned[0]?.message, "[omb] warning: failed to stop stale notify fallback watcher");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("buildNotifyTempStartupMessages", () => {
  it("always emits summary when temp mode is active", () => {
    const result = buildNotifyTempStartupMessages(
      {
        active: true,
        selectors: ["discord"],
        canonicalSelectors: ["discord"],
        warnings: [],
        source: "cli",
      },
      true,
    );
    assert.deepEqual(result.infoLines, [
      "notify temp: active | providers=discord | persistent-routing=bypassed",
    ]);
    assert.deepEqual(result.warningLines, []);
  });

  it("emits no-valid-provider warning when no provider is configured", () => {
    const result = buildNotifyTempStartupMessages(
      {
        active: true,
        selectors: [],
        canonicalSelectors: [],
        warnings: [
          "notify temp: provider selectors imply temp mode (auto-activated)",
        ],
        source: "providers",
      },
      false,
    );
    assert.equal(
      result.warningLines.includes(
        "notify temp: no valid providers resolved; notifications skipped",
      ),
      true,
    );
  });
});

describe("resolveWorkerSparkModel", () => {
  it("returns spark model string when --spark is present", () => {
    assert.equal(
      resolveWorkerSparkModel(["--spark", "--yolo"]),
      expectedLowComplexityModel(),
    );
  });

  it("returns spark model string when --madmax-spark is present", () => {
    assert.equal(
      resolveWorkerSparkModel(["--madmax-spark"]),
      expectedLowComplexityModel(),
    );
  });

  it("returns undefined when neither spark flag is present", () => {
    assert.equal(
      resolveWorkerSparkModel(["--madmax", "--yolo", "--model", "gpt-5"]),
      undefined,
    );
  });

  it("returns undefined for empty args", () => {
    assert.equal(resolveWorkerSparkModel([]), undefined);
  });

  it("reads low-complexity team model from config when codebuddyHomeOverride is provided", async () => {
    const codebuddyHome = await mkdtemp(join(tmpdir(), "omb-codebuddy-home-"));
    try {
      await writeFile(
        join(codebuddyHome, ".omb-config.json"),
        JSON.stringify({ models: { team_low_complexity: "gpt-4.1-mini" } }),
      );
      assert.equal(
        resolveWorkerSparkModel(["--spark"], codebuddyHome),
        "gpt-4.1-mini",
      );
    } finally {
      await rm(codebuddyHome, { recursive: true, force: true });
    }
  });
});

describe("resolveTeamWorkerLaunchArgsEnv (spark)", () => {
  it("injects spark model as worker default when no explicit env model", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        undefined,
        [],
        true,
        expectedLowComplexityModel(),
      ),
      `--model ${expectedLowComplexityModel()}`,
    );
  });

  it("explicit env model overrides spark default", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        "--model gpt-5",
        [],
        true,
        expectedLowComplexityModel(),
      ),
      "--model gpt-5",
    );
  });

  it("inherited leader model overrides spark default", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        undefined,
        ["--model", "gpt-4.1"],
        true,
        expectedLowComplexityModel(),
      ),
      "--model gpt-4.1",
    );
  });
});

describe("commandOwnsLocalHelp", () => {
  it("returns true for nested commands that render their own help output", () => {
    for (const command of [
      "agents-init",
      "ask",
      "autoresearch",
      "deepinit",
      "hooks",
      "hud",
      "ralph",
      "resume",
      "session",
      "sparkshell",
      "team",
      "tmux-hook",
    ]) {
      assert.equal(
        commandOwnsLocalHelp(command),
        true,
        `expected ${command} to own local help`,
      );
    }
  });

  it("returns false for top-level help-only commands", () => {
    for (const command of ["help", "launch", "version"]) {
      assert.equal(
        commandOwnsLocalHelp(command),
        false,
        `expected ${command} to use top-level help`,
      );
    }
  });
});

describe("resolveCliInvocation", () => {
  it("resolves explore to explore command", () => {
    assert.deepEqual(
      resolveCliInvocation(["explore", "--prompt", "find", "auth"]),
      {
        command: "explore",
        launchArgs: [],
      },
    );
  });

  it("resolves ask to ask command", () => {
    assert.deepEqual(resolveCliInvocation(["ask", "claude", "hello"]), {
      command: "ask",
      launchArgs: [],
    });
  });

  it("resolves autoresearch to autoresearch command", () => {
    assert.deepEqual(resolveCliInvocation(["autoresearch", "missions/demo"]), {
      command: "autoresearch",
      launchArgs: [],
    });
  });

  it("resolves session to session command", () => {
    assert.deepEqual(
      resolveCliInvocation(["session", "search", "startup evidence"]),
      {
        command: "session",
        launchArgs: [],
      },
    );
  });

  it("resolves resume to resume command and forwards trailing args", () => {
    assert.deepEqual(resolveCliInvocation(["resume", "--last"]), {
      command: "resume",
      launchArgs: ["--last"],
    });
  });

  it("resolves resume session id and prompt as forwarded args", () => {
    assert.deepEqual(
      resolveCliInvocation(["resume", "session-123", "continue here"]),
      {
        command: "resume",
        launchArgs: ["session-123", "continue here"],
      },
    );
  });

  it("resolves exec to non-interactive launch passthrough and forwards trailing args", () => {
    assert.deepEqual(
      resolveCliInvocation(["exec", "--model", "gpt-5", "say hi"]),
      {
        command: "exec",
        launchArgs: ["--model", "gpt-5", "say hi"],
      },
    );
  });

  it("resolves hooks to hooks command", () => {
    assert.deepEqual(resolveCliInvocation(["hooks"]), {
      command: "hooks",
      launchArgs: [],
    });
  });

  it("resolves agents-init to agents-init command", () => {
    assert.deepEqual(resolveCliInvocation(["agents-init", "."]), {
      command: "agents-init",
      launchArgs: [],
    });
  });

  it("resolves deepinit to deepinit alias command", () => {
    assert.deepEqual(resolveCliInvocation(["deepinit", "src"]), {
      command: "deepinit",
      launchArgs: [],
    });
  });

  it("resolves --help to the help command instead of launch", () => {
    assert.deepEqual(resolveCliInvocation(["--help"]), {
      command: "help",
      launchArgs: [],
    });
  });

  it("resolves --version to the version command instead of launch", () => {
    assert.deepEqual(resolveCliInvocation(["--version"]), {
      command: "version",
      launchArgs: [],
    });
  });

  it("resolves -v to the version command instead of launch", () => {
    assert.deepEqual(resolveCliInvocation(["-v"]), {
      command: "version",
      launchArgs: [],
    });
  });

  it("keeps unknown long flags as launch passthrough args", () => {
    assert.deepEqual(resolveCliInvocation(["--model", "gpt-5"]), {
      command: "launch",
      launchArgs: ["--model", "gpt-5"],
    });
  });
});

describe("resolveCommandTemplateLaunchPrompt", () => {
  it("returns undefined when command templates are disabled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-cli-template-disabled-"));
    try {
      await mkdir(join(cwd, ".codebuddy", "commands"), { recursive: true });
      await writeFile(join(cwd, ".codebuddy", "commands", "greet.md"), "say $ARGUMENTS");

      const prompt = await resolveCommandTemplateLaunchPrompt(
        ["greet", "world"],
        { cwd },
      );

      assert.equal(prompt, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("resolves command prompt with $ARGUMENTS substitution when enabled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-cli-template-enabled-"));
    try {
      await mkdir(join(cwd, ".codebuddy", "commands"), { recursive: true });
      await writeFile(
        join(cwd, ".codebuddy", "commands", "greet.md"),
        "say $ARGUMENTS in code",
      );

      const prompt = await resolveCommandTemplateLaunchPrompt(
        ["greet", "hello", "world"],
        { cwd, env: { OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "1" } },
      );

      assert.equal(prompt, "say hello world in code");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("resolveSetupScopeArg", () => {
  it("returns undefined when scope is omitted", () => {
    assert.equal(resolveSetupScopeArg(["--dry-run"]), undefined);
  });

  it("parses --scope <value> form", () => {
    assert.equal(
      resolveSetupScopeArg(["--dry-run", "--scope", "project"]),
      "project",
    );
  });

  it("parses --scope=<value> form", () => {
    assert.equal(resolveSetupScopeArg(["--scope=project"]), "project");
  });

  it("throws on invalid scope value", () => {
    assert.throws(
      () => resolveSetupScopeArg(["--scope", "workspace"]),
      /Invalid setup scope: workspace/,
    );
  });

  it("throws when --scope value is missing", () => {
    assert.throws(
      () => resolveSetupScopeArg(["--scope"]),
      /Missing setup scope value after --scope/,
    );
  });
});

describe("resolveSetupProviderArg", () => {
  it("returns undefined when provider is omitted", () => {
    assert.equal(resolveSetupProviderArg(["--dry-run"]), undefined);
  });

  it("parses --provider <value> form", () => {
    assert.equal(resolveSetupProviderArg(["--provider", "codex"]), "codex");
    assert.equal(resolveSetupProviderArg(["--provider", "claude"]), "claude");
  });

  it("parses --provider=<value> form", () => {
    assert.equal(resolveSetupProviderArg(["--provider=both"]), "both");
    assert.equal(resolveSetupProviderArg(["--provider=all"]), "all");
  });

  it("throws on invalid provider value", () => {
    assert.throws(
      () => resolveSetupProviderArg(["--provider", "gemini"]),
      /Invalid setup provider: gemini/,
    );
  });

  it("throws when --provider value is missing", () => {
    assert.throws(
      () => resolveSetupProviderArg(["--provider"]),
      /Missing setup provider value after --provider/,
    );
  });
});

describe("project launch scope helpers", () => {
  it("reads persisted setup scope when valid", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );
      assert.equal(readPersistedSetupScope(wd), "project");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("reads persisted setup preferences when skill target is present", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "user" }),
      );
      assert.deepEqual(readPersistedSetupPreferences(wd), {
        scope: "user",
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("reads persisted setup provider when present", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project", provider: "codex" }),
      );
      assert.deepEqual(readPersistedSetupPreferences(wd), {
        scope: "project",
        provider: "codex",
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("reads persisted Claude setup provider when present", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project", provider: "claude" }),
      );
      assert.deepEqual(readPersistedSetupPreferences(wd), {
        scope: "project",
        provider: "claude",
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("ignores malformed persisted setup scope", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(join(wd, ".omb", "setup-scope.json"), "{not-json");
      assert.equal(readPersistedSetupScope(wd), undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses project CODEBUDDY_HOME when persisted scope is project", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );
      assert.equal(resolveCodexHomeForLaunch(wd, {}), join(wd, ".codebuddy"));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses project CODEX_HOME for codex leader when provider is codex", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project", provider: "codex" }),
      );
      assert.equal(resolveCodexHomeForLaunch(wd, {}, "codex"), join(wd, ".codex"));
      assert.equal(resolveCodexHomeForLaunch(wd, {}, "codebuddy"), join(wd, ".codebuddy"));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses project CLAUDE_HOME for claude leader when provider is claude", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project", provider: "claude" }),
      );
      assert.equal(resolveCodexHomeForLaunch(wd, {}, "claude"), join(wd, ".claude"));
      assert.equal(resolveCodexHomeForLaunch(wd, {}, "codex"), join(wd, ".codex"));
      assert.equal(resolveCodexHomeForLaunch(wd, {}, "codebuddy"), join(wd, ".codebuddy"));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses project .codex for codex leader when setup provider is missing (legacy project scope)", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(join(wd, ".omb", "setup-scope.json"), JSON.stringify({ scope: "project" }));
      assert.equal(resolveCodexHomeForLaunch(wd, {}, "codex"), join(wd, ".codex"));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses project .codex for codex leader when legacy project-local scope is used", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(join(wd, ".omb", "setup-scope.json"), JSON.stringify({ scope: "project-local" }));
      assert.equal(resolveCodexHomeForLaunch(wd, {}, "codex"), join(wd, ".codex"));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps explicit CODEBUDDY_HOME override from env", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );
      assert.equal(
        resolveCodexHomeForLaunch(wd, {
          CODEBUDDY_HOME: "/tmp/explicit-codebuddy-home",
        }),
        "/tmp/explicit-codebuddy-home",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps CODEBUDDY_HOME semantics and does not reuse CODEX_HOME for codebuddy leader", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project", provider: "codebuddy" }),
      );
      assert.equal(
        resolveCodexHomeForLaunch(wd, { CODEX_HOME: "/tmp/explicit-codex-home" }, "codebuddy"),
        join(wd, ".codebuddy"),
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('migrates legacy "project-local" persisted scope to "project"', async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project-local" }),
      );
      assert.equal(readPersistedSetupScope(wd), "project");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('resolves CODEBUDDY_HOME for legacy "project-local" persisted scope', async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-launch-scope-"));
    try {
      await mkdir(join(wd, ".omb"), { recursive: true });
      await writeFile(
        join(wd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project-local" }),
      );
      assert.equal(resolveCodexHomeForLaunch(wd, {}), join(wd, ".codebuddy"));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe("resolveCodexLaunchPolicy", () => {
  it("uses detached tmux on macOS when outside tmux and tmux is available", () => {
    assert.equal(
      resolveCodexLaunchPolicy({}, "darwin", true, false, true, true),
      "detached-tmux",
    );
  });

  it("uses tmux-aware launch path when already inside tmux", () => {
    assert.equal(
      resolveCodexLaunchPolicy(
        { TMUX: "/tmp/tmux-1000/default,123,0" },
        "darwin",
        true,
      ),
      "inside-tmux",
    );
  });

  it("uses tmux-aware launch path when already inside tmux on native Windows", () => {
    assert.equal(
      resolveCodexLaunchPolicy(
        { TMUX: "psmux-session" },
        "win32",
        true,
      ),
      "inside-tmux",
    );
  });

  it("uses detached tmux on non-macOS hosts when outside tmux and tmux is available", () => {
    assert.equal(
      resolveCodexLaunchPolicy({}, "linux", true, false, true, true),
      "detached-tmux",
    );
  });

  it("launches directly on native Windows even when tmux is available", () => {
    assert.equal(resolveCodexLaunchPolicy({}, "win32", true, true), "direct");
  });

  it("does not force direct launch for MSYS or Git Bash on win32", () => {
    assert.equal(
      resolveCodexLaunchPolicy(
        { MSYSTEM: "MINGW64" },
        "win32",
        true,
        false,
        true,
      ),
      "direct",
    );
  });

  it("honors explicit detached tmux launch requests when tmux is available", () => {
    assert.equal(
      resolveCodexLaunchPolicy(
        {},
        "linux",
        true,
        false,
        true,
        true,
        "detached-tmux",
      ),
      "detached-tmux",
    );
  });

  it("launches directly when stdin is not a tty outside tmux", () => {
    assert.equal(resolveCodexLaunchPolicy({}, "linux", true, false, false, true), "direct");
  });

  it("launches directly when stdout is not a tty outside tmux", () => {
    assert.equal(resolveCodexLaunchPolicy({}, "linux", true, false, true, false), "direct");
  });

  it("launches directly when tmux is unavailable outside tmux", () => {
    assert.equal(resolveCodexLaunchPolicy({}, "linux", false), "direct");
  });

  it("launches directly on native Windows when tmux is unavailable", () => {
    assert.equal(resolveCodexLaunchPolicy({}, "win32", false, true), "direct");
  });
});

describe("resolveBackgroundHelperLaunchMode", () => {
  it("uses the hidden Windows MSYS bootstrap for win32 Git Bash", () => {
    assert.equal(
      resolveBackgroundHelperLaunchMode({ MSYSTEM: "MINGW64" }, "win32"),
      "windows-msys-bootstrap",
    );
  });

  it("spawns helpers directly on native win32", () => {
    assert.equal(resolveBackgroundHelperLaunchMode({}, "win32"), "direct-detached");
  });

  it("spawns helpers directly on non-Windows platforms", () => {
    assert.equal(
      resolveBackgroundHelperLaunchMode({ MSYSTEM: "MINGW64" }, "linux"),
      "direct-detached",
    );
  });
});

describe("shouldDetachBackgroundHelper", () => {
  it("keeps the long-running helper detached under win32 Git Bash", () => {
    assert.equal(
      shouldDetachBackgroundHelper({ MSYSTEM: "MINGW64" }, "win32"),
      true,
    );
  });

  it("keeps detached helpers on native win32", () => {
    assert.equal(shouldDetachBackgroundHelper({}, "win32"), true);
  });

  it("keeps detached helpers on non-Windows platforms", () => {
    assert.equal(
      shouldDetachBackgroundHelper({ MSYSTEM: "MINGW64" }, "linux"),
      true,
    );
  });
});

describe("classifyCodexExecFailure", () => {
  it("classifies child process exit status as codex exit", () => {
    const err = Object.assign(new Error("codex exited 9"), { status: 9 });
    const classified = classifyCodexExecFailure(err);
    assert.equal(classified.kind, "exit");
    assert.equal(classified.exitCode, 9);
  });

  it("classifies signal termination as codex exit and maps to signal-based exit code", () => {
    const err = Object.assign(new Error("terminated"), {
      status: null,
      signal: "SIGTERM" as NodeJS.Signals,
    });
    const classified = classifyCodexExecFailure(err);
    assert.equal(classified.kind, "exit");
    assert.equal(classified.signal, "SIGTERM");
    assert.equal(classified.exitCode, resolveSignalExitCode("SIGTERM"));
  });

  it("classifies ENOENT as launch error", () => {
    const err = Object.assign(new Error("spawn codex ENOENT"), {
      code: "ENOENT",
    });
    const classified = classifyCodexExecFailure(err);
    assert.equal(classified.kind, "launch-error");
    assert.equal(classified.code, "ENOENT");
  });
});

describe("tmux HUD pane helpers", () => {
  it("findHudWatchPaneIds detects stale HUD watch panes and excludes current pane", () => {
    const panes = parseTmuxPaneSnapshot(
      [
        "%1\tzsh\tzsh",
        "%2\tnode\tnode /tmp/bin/omb.js hud --watch",
        "%3\tnode\tnode /tmp/bin/omb.js hud --watch",
        "%4\tcodex\tcodex --model gpt-5",
      ].join("\n"),
    );
    assert.deepEqual(findHudWatchPaneIds(panes, "%2"), ["%3"]);
  });

  it("buildHudPaneCleanupTargets de-dupes pane ids and includes created pane", () => {
    assert.deepEqual(
      buildHudPaneCleanupTargets(["%3", "%3", "invalid"], "%4"),
      ["%3", "%4"],
    );
  });

  it("buildHudPaneCleanupTargets excludes leader pane from existing ids", () => {
    // %5 is the leader pane — it must not be included even if findHudWatchPaneIds let it through.
    assert.deepEqual(buildHudPaneCleanupTargets(["%3", "%5"], "%4", "%5"), [
      "%3",
      "%4",
    ]);
  });

  it("buildHudPaneCleanupTargets excludes leader pane even when it matches the created HUD pane id", () => {
    // Defensive edge case: if createHudWatchPane somehow returned the leader pane id, guard protects it.
    assert.deepEqual(buildHudPaneCleanupTargets(["%3"], "%5", "%5"), ["%3"]);
  });

  it("buildHudPaneCleanupTargets is a no-op guard when leaderPaneId is absent", () => {
    assert.deepEqual(buildHudPaneCleanupTargets(["%3"], "%4"), ["%3", "%4"]);
  });
});

describe("detached tmux new-session sequencing", () => {
  it("buildDetachedSessionBootstrapSteps uses shared HUD height and split-capture ordering", () => {
    const steps = buildDetachedSessionBootstrapSteps(
      "omb-demo",
      "/tmp/project",
      "'codex' '--model' 'gpt-5'",
      "'node' '/tmp/omb.js' 'hud' '--watch'",
      "--model gpt-5",
      "/tmp/codebuddy-home",
      '{"active":true}',
    );
    assert.deepEqual(
      steps.map((step) => step.name),
      ["new-session", "split-and-capture-hud-pane"],
    );
    assert.equal(steps[1]?.args[3], String(HUD_TMUX_HEIGHT_LINES));
    assert.equal(steps[1]?.args[6], "omb-demo");
    assert.equal(steps[1]?.args.includes("-P"), true);
    assert.equal(steps[1]?.args.includes("#{pane_id}"), true);
    assert.equal(steps[0]?.args.includes("-e"), true);
    assert.equal(steps[0]?.args.includes("CODEBUDDY_HOME=/tmp/codebuddy-home"), true);
    assert.equal(steps[0]?.args.includes("CODEX_HOME=/tmp/codebuddy-home"), false);
    // Default leader CLI is codebuddy; OMB_LEADER_CLI must still be injected so
    // downstream consumers detect the provider explicitly instead of guessing.
    assert.equal(steps[0]?.args.includes("OMB_LEADER_CLI=codebuddy"), true);
    assert.equal(
      steps[0]?.args.includes('OMB_NOTIFY_TEMP_CONTRACT={\"active\":true}'),
      true,
    );
  });

  it("buildDetachedSessionBootstrapSteps forwards CODEX_HOME only for codex detached sessions", () => {
    const steps = buildDetachedSessionBootstrapSteps(
      "omb-demo",
      "/tmp/project",
      "'codex' '--model' 'gpt-5'",
      "'node' '/tmp/omb.js' 'hud' '--watch'",
      null,
      "/tmp/codex-home",
      null,
      false,
      undefined,
      "codex",
    );
    assert.equal(steps[0]?.args.includes("CODEBUDDY_HOME=/tmp/codex-home"), false);
    assert.equal(steps[0]?.args.includes("CODEX_HOME=/tmp/codex-home"), true);
    // OMB_LEADER_CLI must be injected so nested agents-overlay / worker-bootstrap
    // pick the matching AGENTS/home inside the detached session.
    assert.equal(steps[0]?.args.includes("OMB_LEADER_CLI=codex"), true);
  });

  it("buildDetachedSessionBootstrapSteps forwards CLAUDE_HOME only for Claude detached sessions", () => {
    const steps = buildDetachedSessionBootstrapSteps(
      "omb-demo",
      "/tmp/project",
      "'claude' 'exec' 'hi'",
      "'node' '/tmp/omb.js' 'hud' '--watch'",
      null,
      "/tmp/claude-home",
      null,
      false,
      undefined,
      "claude",
    );
    assert.equal(steps[0]?.args.includes("CODEBUDDY_HOME=/tmp/claude-home"), false);
    assert.equal(steps[0]?.args.includes("CODEX_HOME=/tmp/claude-home"), false);
    assert.equal(steps[0]?.args.includes("CLAUDE_HOME=/tmp/claude-home"), true);
    assert.equal(steps[0]?.args.includes("OMB_LEADER_CLI=claude"), true);
  });

  it("buildDetachedSessionBootstrapSteps forwards temp contract env to detached tmux session", () => {
    const steps = buildDetachedSessionBootstrapSteps(
      "omb-demo",
      "/tmp/project",
      "'codex' '--model' 'gpt-5'",
      "'node' '/tmp/omb.js' 'hud' '--watch'",
      null,
      undefined,
      '{"active":true,"canonicalSelectors":["discord"]}',
    );
    const newSession = steps.find((step) => step.name === "new-session");
    assert.ok(newSession);
    assert.equal(
      newSession!.args.includes("-e") &&
        newSession!.args.some((arg) =>
          arg.startsWith("OMB_NOTIFY_TEMP_CONTRACT="),
        ),
      true,
    );
  });

  it("buildDetachedSessionBootstrapSteps forwards OMB_SESSION_ID to detached tmux session", () => {
    const steps = buildDetachedSessionBootstrapSteps(
      "omb-demo",
      "/tmp/project",
      "'codex' '--model' 'gpt-5'",
      "'node' '/tmp/omb.js' 'hud' '--watch'",
      null,
      undefined,
      null,
      false,
      "sess-detached-managed",
    );
    const newSession = steps.find((step) => step.name === "new-session");
    assert.ok(newSession);
    assert.equal(
      newSession!.args.includes("-e") &&
        newSession!.args.some((arg) => arg === "OMB_SESSION_ID=sess-detached-managed"),
      true,
    );
  });

  it("buildDetachedSessionBootstrapSteps starts native Windows detached sessions with powershell", () => {
    const hudCmd = buildWindowsPromptCommand("node", [
      "omb.js",
      "hud",
      "--watch",
    ]);
    const steps = buildDetachedSessionBootstrapSteps(
      "omb-demo",
      "C:/project",
      "'codex' '--dangerously-bypass-approvals-and-sandbox'",
      hudCmd,
      "--model gpt-5",
      "C:/codebuddy-home",
      null,
      true,
    );
    assert.equal(steps[0]?.name, "new-session");
    assert.equal(steps[0]?.args.at(-1), "powershell.exe");
    assert.equal(steps[1]?.name, "split-and-capture-hud-pane");
    assert.equal(steps[1]?.args.at(-1), hudCmd);
  });

  it("buildDetachedSessionBootstrapSteps kills detached tmux session on normal shell exit", () => {
    const steps = buildDetachedSessionBootstrapSteps(
      "omb-demo",
      "/tmp/project",
      "'codex' '--model' 'gpt-5'",
      "'node' '/tmp/omb.js' 'hud' '--watch'",
      null,
    );
    const leaderCmd = steps[0]?.args.at(-1);
    assert.equal(typeof leaderCmd, "string");
    assert.match(leaderCmd!, /^\/bin\/sh -c '/);
    assert.doesNotMatch(leaderCmd!, /^\/bin\/sh -lc '/);
    assert.match(leaderCmd!, /acquireTmuxExtendedKeysLease/);
    assert.match(leaderCmd!, /omb_detached_session_cleanup\(\)/);
    assert.match(leaderCmd!, /trap omb_detached_session_cleanup 0;/);
    assert.match(leaderCmd!, /releaseTmuxExtendedKeysLease/);
    assert.match(leaderCmd!, /if \[ "\$status" -lt 128 \]; then/);
    assert.match(leaderCmd!, /tmux kill-session -t/);
    assert.match(leaderCmd!, /"omb-demo"/);
    assert.match(leaderCmd!, /exit \$status/);
  });

  it("detached leader command executes codex and cleanup without shell-quote breakage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-detached-leader-"));
    // fakeBin lives inside cwd so the `finally { rm cwd }` cleanup covers it.
    // Keeping it under tmpdir (not repo cwd) avoids polluting the working
    // tree if the test crashes. `join(cwd, "bin")` was the original pattern
    // pre-ea0152eb; restored for clean test isolation.
    const fakeBin = join(cwd, "bin");
    const logPath = join(cwd, "leader.log");

    try {
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "codex"),
        `#!/bin/sh
printf 'codex:%s\\n' "$*" >> "${logPath}"
exit 0
`,
      );
      await chmod(join(fakeBin, "codex"), 0o755);
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
printf 'tmux:%s\\n' "$*" >> "${logPath}"
case "$1" in
  display-message)
    if [ "$3" = '#{socket_path}' ] || [ "$4" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\\n'
    else
      printf '0\\n'
    fi
    ;;
  show-options)
    printf 'off\\n'
    ;;
  set-option|kill-session)
    ;;
esac
exit 0
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const steps = buildDetachedSessionBootstrapSteps(
        "omb-demo",
        cwd,
        buildTmuxPaneCommand(
          "codex",
          ["--dangerously-bypass-approvals-and-sandbox"],
          "/bin/sh",
        ),
        "'node' '/tmp/omb.js' 'hud' '--watch'",
        null,
      );
      const leaderCmd = steps[0]?.args.at(-1);
      assert.equal(typeof leaderCmd, "string");

      execFileSync("/bin/sh", ["-c", leaderCmd!], {
        cwd,
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          HOME: cwd,
        },
        stdio: "ignore",
      });

      const log = await readFile(logPath, "utf-8");
      assert.match(log, /codex:--dangerously-bypass-approvals-and-sandbox/);
      assert.match(log, /tmux:display-message -p #\{socket_path\}/);
      // tmux extended-keys lease lifecycle: acquire (show-options + set-option
      // always) runs before the leader process starts; release (set-option
      // <original>) runs after. Asserts that the production shell snippet in
      // `buildTmuxExtendedKeysAcquire/ReleaseShellSnippet` actually spawns
      // the helper subprocess and that PATH-override reaches the fake tmux.
      // Restored from ea0152eb; see commit history for why it was dropped.
      assert.match(log, /tmux:show-options -sv extended-keys/);
      assert.match(log, /tmux:set-option -sq extended-keys always/);
      assert.match(log, /tmux:set-option -sq extended-keys off/);
      assert.match(log, /tmux:kill-session -t omb-demo/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("detached leader command preserves the detached tmux session on signal-derived exits", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-detached-leader-signal-"));
    const fakeBin = join(cwd, "bin");
    const logPath = join(cwd, "leader.log");

    try {
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "codex"),
        `#!/bin/sh
printf 'codex:%s\\n' "$*" >> "${logPath}"
exit 143
`,
      );
      await chmod(join(fakeBin, "codex"), 0o755);
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
printf 'tmux:%s\\n' "$*" >> "${logPath}"
case "$1" in
  display-message)
    if [ "$3" = '#{socket_path}' ] || [ "$4" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\\n'
    else
      printf '0\\n'
    fi
    ;;
  show-options)
    printf 'off\\n'
    ;;
  set-option|kill-session)
    ;;
esac
exit 0
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const steps = buildDetachedSessionBootstrapSteps(
        "omb-demo",
        cwd,
        buildTmuxPaneCommand(
          "codex",
          ["--dangerously-bypass-approvals-and-sandbox"],
          "/bin/sh",
        ),
        "'node' '/tmp/omb.js' 'hud' '--watch'",
        null,
      );
      const leaderCmd = steps[0]?.args.at(-1);
      assert.equal(typeof leaderCmd, "string");

      const result = spawnSync("/bin/sh", ["-c", leaderCmd!], {
        cwd,
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          HOME: cwd,
        },
        encoding: "utf-8",
      });

      assert.equal(result.status, 143);
      const log = await readFile(logPath, "utf-8");
      assert.match(log, /codex:--dangerously-bypass-approvals-and-sandbox/);
      assert.match(log, /tmux:display-message -p #\{socket_path\}/);
      // Even on signal-derived exits (SIGTERM 143 here), the tmux extended-
      // keys lease must still acquire + release so we don't leave the tmux
      // server with `extended-keys always` sticking around after the
      // detached leader dies. Restored from ea0152eb.
      assert.match(log, /tmux:show-options -sv extended-keys/);
      assert.match(log, /tmux:set-option -sq extended-keys always/);
      assert.match(log, /tmux:set-option -sq extended-keys off/);
      assert.doesNotMatch(log, /tmux:kill-session -t omb-demo/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("withTmuxExtendedKeys enables tmux extended keys during codex launch and restores them afterwards", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-tmux-lease-wrapper-"));
    const calls: string[][] = [];
    const result = withTmuxExtendedKeys(
      cwd,
      () => {
        calls.push(["run"]);
        return "ok";
      },
      (_file, args) => {
        calls.push([...args]);
        if (args[0] === "show-options") return "off\n";
        return "";
      },
    );
    await rm(cwd, { recursive: true, force: true });

    assert.equal(result, "ok");
    assert.deepEqual(calls, [
      ["display-message", "-p", "#{socket_path}"],
      ["show-options", "-sv", "extended-keys"],
      ["set-option", "-sq", "extended-keys", "always"],
      ["run"],
      ["set-option", "-sq", "extended-keys", "off"],
    ]);
  });

  it("overlapping tmux extended-keys leases restore only after the last holder exits", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-tmux-lease-overlap-"));
    const calls: string[][] = [];
    const execStub = (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "display-message") return "/tmp/tmux-test.sock\n";
      if (args[0] === "show-options") return "off\n";
      return "";
    };

    const leaseA = acquireTmuxExtendedKeysLease(cwd, execStub);
    const leaseB = acquireTmuxExtendedKeysLease(cwd, execStub);

    assert.equal(typeof leaseA, "string");
    assert.equal(typeof leaseB, "string");

    releaseTmuxExtendedKeysLease(cwd, leaseA!, execStub);

    const leaseDir = join(cwd, ".omb", "state", "tmux-extended-keys");
    const leaseFilesAfterFirstRelease = await readFile(
      join(leaseDir, "tmp-tmux-test-sock.json"),
      "utf-8",
    );
    assert.match(leaseFilesAfterFirstRelease, /holders/);

    releaseTmuxExtendedKeysLease(cwd, leaseB!, execStub);

    await assert.rejects(
      readFile(join(leaseDir, "tmp-tmux-test-sock.json"), "utf-8"),
      /ENOENT/,
    );
    await rm(cwd, { recursive: true, force: true });

    assert.deepEqual(calls, [
      ["display-message", "-p", "#{socket_path}"],
      ["show-options", "-sv", "extended-keys"],
      ["set-option", "-sq", "extended-keys", "always"],
      ["display-message", "-p", "#{socket_path}"],
      ["set-option", "-sq", "extended-keys", "off"],
    ]);
  });

  it("withTmuxExtendedKeys degrades cleanly when tmux option probing fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-tmux-lease-fail-"));
    const calls: string[][] = [];
    const result = withTmuxExtendedKeys(
      cwd,
      () => {
        calls.push(["run"]);
        return "ok";
      },
      (_file, args) => {
        calls.push([...args]);
        if (args[0] === "show-options") throw new Error("tmux unavailable");
        return "";
      },
    );
    await rm(cwd, { recursive: true, force: true });

    assert.equal(result, "ok");
    assert.deepEqual(calls, [
      ["display-message", "-p", "#{socket_path}"],
      ["show-options", "-sv", "extended-keys"],
      ["run"],
    ]);
  });

  it("buildDetachedSessionFinalizeSteps keeps schedule after split-capture and before attach", () => {
    const steps = buildDetachedSessionFinalizeSteps(
      "omb-demo",
      "%12",
      "3",
      true,
    );
    const names = steps.map((step) => step.name);
    const attachedIndex = names.indexOf("register-client-attached-reconcile");
    const scheduleIndex = names.indexOf("schedule-delayed-resize");
    const attachIndex = names.indexOf("attach-session");
    assert.equal(attachedIndex >= 0, true);
    assert.equal(scheduleIndex > attachedIndex, true);
    assert.equal(scheduleIndex >= 0, true);
    assert.equal(attachIndex > scheduleIndex, true);
    assert.equal(names.includes("register-resize-hook"), true);
    assert.equal(names.includes("reconcile-hud-resize"), true);
  });

  it("buildDetachedSessionFinalizeSteps uses quiet best-effort tmux resize commands", () => {
    const steps = buildDetachedSessionFinalizeSteps(
      "omb-demo",
      "%12",
      "3",
      false,
    );
    const registerHook = steps.find(
      (step) => step.name === "register-resize-hook",
    );
    const schedule = steps.find(
      (step) => step.name === "schedule-delayed-resize",
    );
    const reconcile = steps.find(
      (step) => step.name === "reconcile-hud-resize",
    );

    assert.match(registerHook?.args[4] ?? "", />\/dev\/null 2>&1 \|\| true/);
    assert.match(
      registerHook?.args[4] ?? "",
      new RegExp(`-y ${HUD_TMUX_HEIGHT_LINES}\\b`),
    );
    assert.match(schedule?.args[2] ?? "", />\/dev\/null 2>&1 \|\| true/);
    assert.match(
      schedule?.args[2] ?? "",
      new RegExp(`-y ${HUD_TMUX_HEIGHT_LINES}\\b`),
    );
    assert.match(
      (reconcile?.args ?? []).join(" "),
      />\/dev\/null 2>&1 \|\| true/,
    );
    assert.match(
      (reconcile?.args ?? []).join(" "),
      new RegExp(`-y ${HUD_TMUX_HEIGHT_LINES}\\b`),
    );
  });

  it("buildDetachedSessionFinalizeSteps skips detached resize hooks on native Windows", () => {
    const steps = buildDetachedSessionFinalizeSteps(
      "omb-demo",
      "%12",
      "3",
      true,
      true,
    );
    assert.deepEqual(
      steps.map((step) => step.name),
      ["set-mouse", "attach-session"],
    );
  });

  it("buildDetachedSessionFinalizeSteps never appends server-global terminal-overrides", () => {
    const steps = buildDetachedSessionFinalizeSteps(
      "omb-demo",
      "%12",
      "3",
      true,
    );
    assert.equal(
      steps.some((step) => step.name === "set-wsl-xt"),
      false,
    );
    assert.equal(
      steps.some((step) => step.args.includes("terminal-overrides")),
      false,
    );
  });

  it("buildDetachedSessionRollbackSteps unregisters hooks before killing session", () => {
    const steps = buildDetachedSessionRollbackSteps(
      "omb-demo",
      "omb-demo:0",
      "omb_resize_launch_demo_0_12",
      "omb_attached_launch_demo_0_12",
    );
    assert.deepEqual(
      steps.map((step) => step.name),
      [
        "unregister-client-attached-reconcile",
        "unregister-resize-hook",
        "kill-session",
      ],
    );
    assert.equal(steps[0]?.args[0], "set-hook");
    assert.equal(steps[0]?.args[1], "-u");
    assert.equal(steps[0]?.args[2], "-t");
    assert.equal(steps[0]?.args[3], "omb-demo:0");
    assert.match(steps[0]?.args[4] ?? "", /^client-attached\[\d+\]$/);
    assert.match(steps[1]?.args[4] ?? "", /^client-resized\[\d+\]$/);
    assert.deepEqual(steps[2]?.args, ["kill-session", "-t", "omb-demo"]);
  });

  it("buildDetachedSessionRollbackSteps only kills session when no hook metadata exists", () => {
    const steps = buildDetachedSessionRollbackSteps(
      "omb-demo",
      null,
      null,
      null,
    );
    assert.deepEqual(
      steps.map((step) => step.name),
      ["kill-session"],
    );
  });
});

describe("buildTmuxShellCommand", () => {
  it("preserves quoted config values for tmux shell-command execution", () => {
    assert.equal(
      buildTmuxShellCommand("codebuddy", [
        "--dangerously-skip-permissions",
        "--effort",
        "xhigh",
      ]),
      `'codebuddy' '--dangerously-skip-permissions' '--effort' 'xhigh'`,
    );
  });
});

describe("buildTmuxPaneCommand", () => {
  it("wraps command with zsh profile sourcing while preserving tmux cwd", () => {
    const result = buildTmuxPaneCommand(
      "codex",
      ["--model", "gpt-5"],
      "/usr/bin/zsh",
    );
    assert.ok(
      result.startsWith("'/usr/bin/zsh' -c "),
      "should start with zsh non-login shell to preserve tmux cwd",
    );
    assert.ok(!result.includes(" -lc "), "should not use a login shell");
    assert.ok(result.includes("source ~/.zshrc"), "should source .zshrc");
    assert.ok(result.includes("exec "), "should exec the command");
  });

  it("wraps command with bash profile sourcing while preserving tmux cwd", () => {
    const result = buildTmuxPaneCommand("codex", [], "/bin/bash");
    assert.ok(
      result.startsWith("'/bin/bash' -c "),
      "should start with bash non-login shell to preserve tmux cwd",
    );
    assert.ok(!result.includes(" -lc "), "should not use a login shell");
    assert.ok(result.includes("source ~/.bashrc"), "should source .bashrc");
    assert.ok(result.includes("exec "), "should exec the command");
  });

  it("skips rc sourcing for unknown shells without using a login shell", () => {
    const result = buildTmuxPaneCommand("codex", [], "/bin/fish");
    assert.ok(
      result.startsWith("'/bin/fish' -c "),
      "should start with fish non-login shell",
    );
    assert.ok(!result.includes(" -lc "), "should not use a login shell");
    assert.ok(!result.includes("source"), "should not source any rc file");
    assert.ok(result.includes("exec "), "should exec the command");
  });

  it("falls back to /bin/sh without using a login shell when shell path is empty", () => {
    const result = buildTmuxPaneCommand("codex", [], "");
    assert.ok(
      result.startsWith("'/bin/sh' -c "),
      "should fall back to /bin/sh",
    );
    assert.ok(!result.includes(" -lc "), "should not use a login shell");
  });
});

describe("buildWindowsPromptCommand", () => {
  it("encodes detached Windows commands for safe PowerShell prompt injection", () => {
    const result = buildWindowsPromptCommand("codebuddy", [
      "--dangerously-skip-permissions",
      "--effort",
      "high",
      "it's",
    ]);
    const prefix = "powershell.exe -NoLogo -NoExit -EncodedCommand ";
    assert.ok(result.startsWith(prefix));
    const payload = result.slice(prefix.length);
    const decoded = Buffer.from(payload, "base64").toString("utf16le");
    assert.equal(
      decoded,
      "$ErrorActionPreference = 'Stop'; & { & 'codebuddy' '--dangerously-skip-permissions' '--effort' 'high' 'it''s' }",
    );
  });
});

describe("buildTmuxSessionName", () => {
  it("uses detached fallback quietly outside git repos", () => {
    const name = buildTmuxSessionName(
      "/tmp/My Repo",
      "omb-1770992424158-abc123",
    );
    assert.equal(name, "omb-my-repo-detached-1770992424158-abc123");
  });

  it("sanitizes invalid characters", () => {
    const name = buildTmuxSessionName("/tmp/@#$", "omb-+++");
    assert.match(
      name,
      /^omb-(unknown|[a-z0-9-]+)-[a-z0-9-]+-(unknown|[a-z0-9-]+)$/,
    );
    assert.equal(name.includes("_"), false);
    assert.equal(name.includes(" "), false);
  });

  it("includes repo name when cwd is inside .omb-worktrees", () => {
    const name = buildTmuxSessionName(
      "/home/user/my-repo.omb-worktrees/launch-feature-x",
      "omb-123-abc",
    );
    assert.match(name, /^omb-my-repo-launch-feature-x-/);
  });

  it("includes repo name for detached worktree paths", () => {
    const name = buildTmuxSessionName(
      "/projects/cool-project.omb-worktrees/launch-detached",
      "omb-456-def",
    );
    assert.match(name, /^omb-cool-project-launch-detached-/);
  });

  it("includes repo name when cwd is inside .omb/worktrees", () => {
    const name = buildTmuxSessionName(
      "/home/user/my-repo/.omb/worktrees/autoresearch-demo",
      "omb-789-ghi",
    );
    assert.match(name, /^omb-my-repo-autoresearch-demo-/);
  });
});

describe("buildDetachedTmuxSessionName", () => {
  it("reuses the OMB session id for the detached tmux session name", () => {
    const sessionName = buildDetachedTmuxSessionName(
      "/tmp/My Repo",
      "omb-1770992424158-abc123",
    );
    assert.equal(sessionName, "omb-my-repo-detached-1770992424158-abc123");
  });
});

describe("team worker launch arg inheritance helpers", () => {
  it("collectInheritableTeamWorkerArgs extracts bypass, reasoning, and model overrides", () => {
    assert.deepEqual(
      collectInheritableTeamWorkerArgs([
        "--dangerously-bypass-approvals-and-sandbox",
        "-c",
        'model_reasoning_effort="xhigh"',
        "--model",
        "gpt-5",
      ]),
      [
        "--dangerously-bypass-approvals-and-sandbox",
        "-c",
        'model_reasoning_effort="xhigh"',
        "--model",
        "gpt-5",
      ],
    );
  });

  it("collectInheritableTeamWorkerArgs supports --model=<value> syntax", () => {
    assert.deepEqual(
      collectInheritableTeamWorkerArgs(["--model=gpt-5.3-codex"]),
      ["--model", "gpt-5.3-codex"],
    );
  });

  it("resolveTeamWorkerLaunchArgsEnv merges and normalizes with de-dupe + last reasoning/model wins", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--dangerously-skip-permissions -c model_reasoning_effort="high" --model old-a --no-alt-screen --model=old-b',
        [
          "-c",
          'model_reasoning_effort="xhigh"',
          "--dangerously-skip-permissions",
          "--model",
          "gpt-5",
        ],
        true,
      ),
      '--dangerously-skip-permissions --no-alt-screen -c model_reasoning_effort="xhigh" --model old-b',
    );
  });

  it("resolveTeamWorkerLaunchArgsEnv can opt out of leader inheritance", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        "--no-alt-screen",
        [
          "--dangerously-skip-permissions",
          "-c",
          'model_reasoning_effort="xhigh"',
        ],
        false,
      ),
      "--no-alt-screen",
    );
  });

  it("resolveTeamWorkerLaunchArgsEnv uses inherited model when env model is absent", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        "--no-alt-screen",
        ["--model=gpt-5.3-codex"],
        true,
      ),
      "--no-alt-screen --model gpt-5.3-codex",
    );
  });

  it("resolveTeamWorkerLaunchArgsEnv uses frontier default model when env and inherited models are absent", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        "--no-alt-screen",
        ["--dangerously-bypass-approvals-and-sandbox"],
        true,
        DEFAULT_FRONTIER_MODEL,
      ),
      `--no-alt-screen --dangerously-bypass-approvals-and-sandbox --model ${DEFAULT_FRONTIER_MODEL}`,
    );
  });

  it("resolveTeamWorkerLaunchArgsEnv keeps exactly one final model with precedence env > inherited > default", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        "--model env-model --model=env-model-final",
        ["--model", "inherited-model"],
        true,
        "fallback-model",
      ),
      "--model env-model-final",
    );
  });

  it("resolveTeamWorkerLaunchArgsEnv prefers inherited model over default when env model is absent", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        "--no-alt-screen",
        ["--model", "inherited-model"],
        true,
        "fallback-model",
      ),
      "--no-alt-screen --model inherited-model",
    );
  });
});

describe("readTopLevelTomlString", () => {
  it("reads a top-level string value", () => {
    const value = readTopLevelTomlString(
      'model_reasoning_effort = "high"\n[mcp_servers.test]\nmodel_reasoning_effort = "low"\n',
      "model_reasoning_effort",
    );
    assert.equal(value, "high");
  });

  it("ignores table-local values", () => {
    const value = readTopLevelTomlString(
      '[mcp_servers.test]\nmodel_reasoning_effort = "xhigh"\n',
      "model_reasoning_effort",
    );
    assert.equal(value, null);
  });
});

describe("injectModelInstructionsBypassArgs", () => {
  it("appends system-prompt-file override by default", () => {
    const args = injectModelInstructionsBypassArgs(
      "/tmp/my-project",
      ["--model", "gpt-5"],
      {},
    );
    assert.deepEqual(args, [
      "--model",
      "gpt-5",
      "--system-prompt-file",
      "/tmp/my-project/AGENTS.md",
    ]);
  });

  it("does not append when bypass is disabled via env", () => {
    const args = injectModelInstructionsBypassArgs(
      "/tmp/my-project",
      ["--model", "gpt-5"],
      { OMB_BYPASS_DEFAULT_SYSTEM_PROMPT: "0" },
    );
    assert.deepEqual(args, ["--model", "gpt-5"]);
  });

  it("does not append when system prompt is already set", () => {
    const args = injectModelInstructionsBypassArgs(
      "/tmp/my-project",
      ["--system-prompt-file", "/tmp/custom.md"],
      {},
    );
    assert.deepEqual(args, ["--system-prompt-file", "/tmp/custom.md"]);
  });

  it("respects OMB_MODEL_INSTRUCTIONS_FILE env override", () => {
    const args = injectModelInstructionsBypassArgs("/tmp/my-project", [], {
      OMB_MODEL_INSTRUCTIONS_FILE: "/tmp/alt instructions.md",
    });
    assert.deepEqual(args, [
      "--system-prompt-file",
      "/tmp/alt instructions.md",
    ]);
  });

  it("uses session-scoped default system prompt file when provided", () => {
    const args = injectModelInstructionsBypassArgs(
      "/tmp/my-project",
      ["--model", "gpt-5"],
      {},
      "/tmp/my-project/.omb/state/sessions/session-1/AGENTS.md",
    );
    assert.deepEqual(args, [
      "--model",
      "gpt-5",
      "--system-prompt-file",
      "/tmp/my-project/.omb/state/sessions/session-1/AGENTS.md",
    ]);
  });

  it("passes help through without injecting a system prompt file", () => {
    const args = injectModelInstructionsBypassArgs(
      "/tmp/my-project",
      ["--help"],
      {},
    );
    assert.deepEqual(args, ["--help"]);
  });

  it("uses Codex config syntax when the selected leader CLI is Codex", () => {
    const args = injectLeaderModelInstructionsBypassArgs(
      "/tmp/my-project",
      ["--model", "gpt-5"],
      "codex",
      {},
      "/tmp/my-project/.omb/state/sessions/session-1/AGENTS.md",
    );
    assert.deepEqual(args, [
      "--model",
      "gpt-5",
      "-c",
      'model_instructions_file="/tmp/my-project/.omb/state/sessions/session-1/AGENTS.md"',
    ]);
  });
});

describe("upsertTopLevelTomlString", () => {
  it("replaces an existing top-level key", () => {
    const updated = upsertTopLevelTomlString(
      'model_reasoning_effort = "low"\n[tui]\nstatus_line = []\n',
      "model_reasoning_effort",
      "high",
    );
    assert.match(updated, /^model_reasoning_effort = "high"$/m);
    assert.doesNotMatch(updated, /^model_reasoning_effort = "low"$/m);
  });

  it("inserts before the first table when key is missing", () => {
    const updated = upsertTopLevelTomlString(
      "[tui]\nstatus_line = []\n",
      "model_reasoning_effort",
      "xhigh",
    );
    assert.equal(
      updated,
      'model_reasoning_effort = "xhigh"\n[tui]\nstatus_line = []\n',
    );
  });
});
