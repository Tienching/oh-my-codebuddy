import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { commandOwnsLocalHelp, resolveCliInvocation } from "../index.js";
import { launchDetachedHandoffSession, launchHandoffSession, switchCommand, type HandoffSessionLaunchInput } from "../switch.js";
import { getProcessIdentityAdapter, type ProcessIdentity } from "../../runtime/process-identity.js";

function runOmb(cwd: string, argv: string[]) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, "..", "..", "..");
  const ombBin = join(repoRoot, "dist", "cli", "omb.js");
  return spawnSync(process.execPath, [ombBin, ...argv], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, HOME: join(cwd, "home"), XDG_CONFIG_HOME: join(cwd, "xdg"), OMB_AUTO_UPDATE: "0", OMB_NOTIFY_FALLBACK: "0", OMB_HOOK_DERIVED_SIGNALS: "0" },
  });
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function waitForIdentity(pid: number): Promise<ProcessIdentity> {
  const adapter = getProcessIdentityAdapter();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const identity = adapter.readIdentity(pid);
    if (identity?.cmdline) return identity;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Could not read process identity for pid ${pid}`);
}

describe("omb switch", () => {
  it("is a first-class local-help command", () => {
    assert.deepEqual(resolveCliInvocation(["switch", "--to", "claude", "--dry-run"]), { command: "switch", launchArgs: [] });
    assert.equal(commandOwnsLocalHelp("switch"), true);
  });

  it("dry-run previews creating a new handoff and launch command without writing files", async () => {
    await withTempDir("omb-switch-cli-dry-", async (cwd) => {
      const res = runOmb(cwd, ["switch", "--to", "claude", "--dry-run", "--task", "provider handoff"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Switch dry run/);
      assert.match(res.stdout, /Would create handoff/);
      assert.match(res.stdout, /omb --leader-cli claude/);
      assert.equal(existsSync(join(cwd, ".omb")), false);
    });
  });

  it("rejects the removed --reason flag", async () => {
    await withTempDir("omb-switch-cli-no-reason-", async (cwd) => {
      const res = runOmb(cwd, ["switch", "--to", "claude", "--reason", "provider handoff"]);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr || res.stdout, /Unknown switch argument: --reason/);
    });
  });

  it("prepares switch state with a new handoff without launching by default", async () => {
    await withTempDir("omb-switch-cli-prepare-", async (cwd) => {
      const res = runOmb(cwd, ["switch", "--to", "codex", "--task", "continue tests"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Prepared switch/);
      assert.match(res.stdout, /Next: omb --leader-cli codex/);
      const state = JSON.parse(await readFile(join(cwd, ".omb", "state", "leader-lock.json"), "utf-8"));
      assert.equal(state.target_leader, "codex");
      assert.equal(state.handoff_in_progress, true);
      assert.equal(state.handoff_phase, "prepared");
    });
  });

  it("inherits madmax into the prepared launch command when the active session was started with bypass", async () => {
    await withTempDir("omb-switch-cli-prepare-madmax-", async (cwd) => {
      await mkdir(join(cwd, ".omb", "state"), { recursive: true });
      await writeFile(
        join(cwd, ".omb", "state", "session.json"),
        JSON.stringify({
          session_id: "old-session-1",
          pid_cmdline: "node /home/ubuntu/.local/bin/omb resume --madmax",
        }, null, 2),
      );

      const lines: string[] = [];
      await switchCommand(["--to", "codex", "--task", "continue tests"], {
        cwd,
        env: { ...process.env, OMB_SESSION_ID: "old-session-1" },
        stdout: (line) => lines.push(line),
      });

      const output = lines.join("\n");
      assert.match(output, /Prepared switch/);
      assert.match(output, /Next: omb --leader-cli codex --madmax/);

      const state = JSON.parse(await readFile(join(cwd, ".omb", "state", "leader-lock.json"), "utf-8"));
      assert.equal(state.launch_command, "omb --leader-cli codex --madmax");
    });
  });

  it("does NOT infer madmax from env when session.json is authoritative and explicitly has no bypass", async () => {
    await withTempDir("omb-switch-cli-session-overrides-env-", async (cwd) => {
      // Session.json explicitly belongs to the current runtime AND its
      // pid_cmdline carries no bypass marker — that is the leader's
      // authoritative truth. A stale shell-exported OMB_TEAM_WORKER_LAUNCH_ARGS
      // must NOT silently upgrade the new leader to bypass.
      await mkdir(join(cwd, ".omb", "state"), { recursive: true });
      await writeFile(
        join(cwd, ".omb", "state", "session.json"),
        JSON.stringify({
          session_id: "old-session-no-bypass",
          pid_cmdline: "node /home/ubuntu/.local/bin/omb --leader-cli codex",
        }, null, 2),
      );

      const lines: string[] = [];
      await switchCommand(["--to", "claude", "--task", "continue"], {
        cwd,
        env: {
          ...process.env,
          OMB_SESSION_ID: "old-session-no-bypass",
          OMB_TEAM_WORKER_LAUNCH_ARGS: "--dangerously-skip-permissions",
        },
        stdout: (line) => lines.push(line),
      });

      const output = lines.join("\n");
      assert.match(output, /Next: omb --leader-cli claude\b/);
      assert.doesNotMatch(output, /Next: omb --leader-cli claude --madmax/);
    });
  });

  it("emits a stderr warning when inferring madmax from env fallback", async () => {
    await withTempDir("omb-switch-cli-env-warning-", async (cwd) => {
      const originalWrite = process.stderr.write.bind(process.stderr);
      const stderrChunks: string[] = [];
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
        return true;
      }) as typeof process.stderr.write;

      try {
        await switchCommand(["--to", "claude", "--task", "continue"], {
          cwd,
          env: {
            ...process.env,
            OMB_TEAM_WORKER_LAUNCH_ARGS: "--dangerously-skip-permissions",
          },
          stdout: () => {},
        });
      } finally {
        process.stderr.write = originalWrite;
      }

      const stderrOutput = stderrChunks.join("");
      assert.match(stderrOutput, /inferred --madmax from env/);
    });
  });

  it("does NOT emit env-warning when --madmax is passed explicitly", async () => {
    await withTempDir("omb-switch-cli-explicit-no-warning-", async (cwd) => {
      const originalWrite = process.stderr.write.bind(process.stderr);
      const stderrChunks: string[] = [];
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
        return true;
      }) as typeof process.stderr.write;

      try {
        await switchCommand(["--to", "claude", "--task", "continue", "--madmax"], {
          cwd,
          env: {
            ...process.env,
            // Even with env signal also present, explicit flag should win
            // and there is no reason to print the inference notice.
            OMB_TEAM_WORKER_LAUNCH_ARGS: "--dangerously-skip-permissions",
          },
          stdout: () => {},
        });
      } finally {
        process.stderr.write = originalWrite;
      }

      const stderrOutput = stderrChunks.join("");
      assert.doesNotMatch(stderrOutput, /inferred --madmax from env/);
    });
  });

  it("inherits madmax from OMB_TEAM_WORKER_LAUNCH_ARGS env when session.json is missing", async () => {
    await withTempDir("omb-switch-cli-env-fallback-madmax-", async (cwd) => {
      // Do NOT write session.json — simulates the failure seen when codebuddy
      // was started via a non-tmux path and writeSessionStart never fired.
      const lines: string[] = [];
      await switchCommand(["--to", "claude", "--task", "continue"], {
        cwd,
        env: {
          ...process.env,
          OMB_SESSION_ID: "omb-session-without-session-json",
          OMB_TEAM_WORKER_LAUNCH_ARGS: "--dangerously-skip-permissions",
        },
        stdout: (line) => lines.push(line),
      });

      const output = lines.join("\n");
      assert.match(output, /Prepared switch/);
      assert.match(output, /Next: omb --leader-cli claude --madmax/);

      const state = JSON.parse(await readFile(join(cwd, ".omb", "state", "leader-lock.json"), "utf-8"));
      assert.equal(state.launch_command, "omb --leader-cli claude --madmax");
    });
  });

  it("inherits madmax from OMB_LEADER_LAUNCH_ARGS env when session.json is missing", async () => {
    await withTempDir("omb-switch-cli-env-fallback-leader-args-", async (cwd) => {
      const lines: string[] = [];
      await switchCommand(["--to", "codex", "--task", "continue"], {
        cwd,
        env: {
          ...process.env,
          OMB_LEADER_LAUNCH_ARGS: "--madmax",
        },
        stdout: (line) => lines.push(line),
      });

      const output = lines.join("\n");
      assert.match(output, /Next: omb --leader-cli codex --madmax/);
    });
  });

  it("recognises --yolo as a bypass signal in env fallback", async () => {
    await withTempDir("omb-switch-cli-env-fallback-yolo-", async (cwd) => {
      const lines: string[] = [];
      await switchCommand(["--to", "claude", "--task", "continue"], {
        cwd,
        env: {
          ...process.env,
          OMB_TEAM_WORKER_LAUNCH_ARGS: "--yolo",
        },
        stdout: (line) => lines.push(line),
      });

      const output = lines.join("\n");
      assert.match(output, /Next: omb --leader-cli claude --madmax/);
    });
  });

  it("recognises --yolo as a bypass signal in pid_cmdline", async () => {
    await withTempDir("omb-switch-cli-cmdline-yolo-", async (cwd) => {
      await mkdir(join(cwd, ".omb", "state"), { recursive: true });
      await writeFile(
        join(cwd, ".omb", "state", "session.json"),
        JSON.stringify({
          session_id: "old-session-yolo",
          pid_cmdline: "node /home/ubuntu/.local/bin/omb --leader-cli codex --yolo",
        }, null, 2),
      );

      const lines: string[] = [];
      await switchCommand(["--to", "claude", "--task", "continue"], {
        cwd,
        env: { ...process.env, OMB_SESSION_ID: "old-session-yolo" },
        stdout: (line) => lines.push(line),
      });

      const output = lines.join("\n");
      assert.match(output, /Next: omb --leader-cli claude --madmax/);
    });
  });

  it("honours explicit --madmax passed to switch even when no session or env signals bypass", async () => {
    await withTempDir("omb-switch-cli-explicit-madmax-", async (cwd) => {
      const lines: string[] = [];
      await switchCommand(["--to", "claude", "--task", "continue", "--madmax"], {
        cwd,
        env: {
          // No session.json. No OMB_TEAM_WORKER_LAUNCH_ARGS. No OMB_LEADER_LAUNCH_ARGS.
          // Only the explicit CLI flag should drive bypass.
          PATH: process.env.PATH ?? "",
        },
        stdout: (line) => lines.push(line),
      });

      const output = lines.join("\n");
      assert.match(output, /Next: omb --leader-cli claude --madmax/);

      const state = JSON.parse(await readFile(join(cwd, ".omb", "state", "leader-lock.json"), "utf-8"));
      assert.equal(state.launch_command, "omb --leader-cli claude --madmax");
    });
  });

  it("deduplicates inherited madmax when the user also passes --madmax explicitly", async () => {
    await withTempDir("omb-switch-cli-dedup-madmax-", async (cwd) => {
      const lines: string[] = [];
      await switchCommand(["--to", "claude", "--task", "continue", "--madmax"], {
        cwd,
        env: {
          ...process.env,
          OMB_TEAM_WORKER_LAUNCH_ARGS: "--dangerously-skip-permissions",
        },
        stdout: (line) => lines.push(line),
      });

      const output = lines.join("\n");
      // Should be "--madmax" exactly once, not "--madmax --madmax"
      const matches = output.match(/--madmax/g) ?? [];
      // Appears once in "Next:" and possibly echoed in prompt; minimum: does not appear twice in launch command.
      assert.match(output, /Next: omb --leader-cli claude --madmax\n/);
      assert.ok(!/--madmax --madmax/.test(output), `expected --madmax to appear once in launch command, got: ${matches.length} matches. Output:\n${output}`);
    });
  });

  it("inherits madmax from live provider session state even when wrapper and provider session ids differ", async () => {
    await withTempDir("omb-switch-cli-provider-session-madmax-", async (cwd) => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)", "--", "--madmax"], {
        stdio: "ignore",
      });
      try {
        assert.ok(child.pid, "child pid should be available");
        const identity = await waitForIdentity(child.pid);
        await mkdir(join(cwd, ".omb", "state"), { recursive: true });
        await writeFile(
          join(cwd, ".omb", "state", "session.json"),
          JSON.stringify({
            session_id: "provider-native-session-1",
            started_at: new Date().toISOString(),
            cwd,
            pid: child.pid,
            platform: process.platform,
            pid_start_ticks: identity.startTicks,
            pid_cmdline: identity.cmdline,
          }, null, 2),
        );

        const lines: string[] = [];
        await switchCommand(["--to", "codex", "--task", "continue tests"], {
          cwd,
          env: { ...process.env, OMB_SESSION_ID: "omb-wrapper-session-1" },
          stdout: (line) => lines.push(line),
        });

        const output = lines.join("\n");
        assert.match(output, /Prepared switch/);
        assert.match(output, /Next: omb --leader-cli codex --madmax/);
      } finally {
        if (child.pid) {
          try { process.kill(child.pid); } catch { /* already exited */ }
        }
      }
    });
  });

  it("launches a detached handoff session through the launcher dependency and records session details", async () => {
    await withTempDir("omb-switch-cli-launch-", async (cwd) => {
      await mkdir(join(cwd, ".omb", "state"), { recursive: true });
      await writeFile(
        join(cwd, ".omb", "state", "session.json"),
        JSON.stringify({
          session_id: "old-session-1",
          pid_cmdline: "node /home/ubuntu/.local/bin/omb resume --madmax",
        }, null, 2),
      );

      const lines: string[] = [];
      const launchInputs: HandoffSessionLaunchInput[] = [];
      await switchCommand(
        ["--to", "claude", "--task", "continue tests", "--launch"],
        {
          cwd,
          env: { ...process.env, OMB_SESSION_ID: "old-session-1" },
          stdout: (line) => lines.push(line),
          launch: async (input) => {
            launchInputs.push(input);
            assert.equal(input.to, "claude");
            assert.deepEqual(input.leaderLaunchArgs, ["--madmax"]);
            assert.match(input.prompt, /You are taking over as the OMB leader provider/);
            assert.match(input.prompt, /\.omb\/handoffs\/latest\.md/);
            assert.match(input.prompt, /## Original \/ Current Task/);
            assert.match(input.prompt, /continue tests/);
            return {
              sessionId: "new-session-1",
              sessionName: "omb-new-session-1",
              takeoverPromptPath: join(cwd, ".omb", "handoffs", "takeover.md"),
              launchCommand: "tmux attach -t omb-new-session-1",
            };
          },
        },
      );

      assert.equal(launchInputs.length, 1);
      const output = lines.join("\n");
      assert.match(output, /Launched switch/);
      assert.match(output, /New claude session is ready: omb-new-session-1/);
      assert.match(output, /tmux switch-client -t omb-new-session-1/);
      assert.match(output, /I will stop editing in this session now/);

      const state = JSON.parse(await readFile(join(cwd, ".omb", "state", "leader-lock.json"), "utf-8"));
      assert.equal(state.handoff_phase, "launched");
      assert.equal(state.old_session_id, "old-session-1");
      assert.equal(state.new_session_id, "new-session-1");
      assert.equal(state.new_session_name, "omb-new-session-1");
      assert.equal(state.takeover_prompt_path, join(cwd, ".omb", "handoffs", "takeover.md"));
    });
  });

  it("passes inherited madmax through the default tmux launcher command", async () => {
    await withTempDir("omb-switch-cli-launch-default-", async (cwd) => {
      const fakeBin = join(cwd, "bin");
      const logPath = join(cwd, "tmux.log");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  new-session)
    printf 'demo-detached\t%%55\n'
    ;;
  display-message)
    if [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%55" ]; then
      printf '0\t12345\tnode\n'
    else
      printf '\n'
    fi
    ;;
  capture-pane)
    printf 'ready\n'
    ;;
  *)
    ;;
esac
exit 0
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const previousPath = process.env.PATH;
      process.env.PATH = `${fakeBin}:${previousPath || ""}`;
      try {
        await launchDetachedHandoffSession({
          cwd,
          to: "codex",
          prompt: "take over safely",
          handoffId: "handoff-test-1",
          leaderLaunchArgs: ["--madmax"],
        });
      } finally {
        if (typeof previousPath === "string") process.env.PATH = previousPath;
        else delete process.env.PATH;
      }

      const tmuxLog = await readFile(logPath, "utf-8");
      assert.match(tmuxLog, /--leader-cli/);
      assert.match(tmuxLog, /codex/);
      assert.match(tmuxLog, /--madmax/);
      assert.match(tmuxLog, /new-session -d -P -F/);
    });
  });

  it("claude wrapper propagates OMB_SESSION_ID and OMB_TEAM_WORKER_LAUNCH_ARGS into the spawned process env", async () => {
    await withTempDir("omb-switch-cli-launch-claude-env-", async (cwd) => {
      const fakeBin = join(cwd, "bin");
      const logPath = join(cwd, "tmux.log");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  new-session)
    printf 'demo-detached\t%%77\n'
    ;;
  display-message)
    if [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%77" ]; then
      printf '0\t54321\tnode\n'
    else
      printf '\n'
    fi
    ;;
  capture-pane)
    printf '> \n'
    ;;
  load-buffer|paste-buffer|delete-buffer|send-keys)
    ;;
  *)
    ;;
esac
exit 0
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const previousPath = process.env.PATH;
      const previousSessionId = process.env.OMB_SESSION_ID;
      const previousWorkerArgs = process.env.OMB_TEAM_WORKER_LAUNCH_ARGS;
      process.env.PATH = `${fakeBin}:${previousPath || ""}`;
      process.env.OMB_SESSION_ID = "omb-real-session-777";
      process.env.OMB_TEAM_WORKER_LAUNCH_ARGS = "--dangerously-skip-permissions";
      try {
        await launchDetachedHandoffSession({
          cwd,
          to: "claude",
          prompt: "take over safely",
          handoffId: "handoff-test-claude-env",
          leaderLaunchArgs: ["--madmax"],
        });
      } finally {
        if (typeof previousPath === "string") process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousSessionId === "string") process.env.OMB_SESSION_ID = previousSessionId;
        else delete process.env.OMB_SESSION_ID;
        if (typeof previousWorkerArgs === "string") process.env.OMB_TEAM_WORKER_LAUNCH_ARGS = previousWorkerArgs;
        else delete process.env.OMB_TEAM_WORKER_LAUNCH_ARGS;
      }

      const tmuxLog = await readFile(logPath, "utf-8");
      // The claude wrapper script should embed env assignments for the propagated vars.
      assert.match(tmuxLog, /env\.OMB_SESSION_ID = "omb-real-session-777"/);
      assert.match(tmuxLog, /env\.OMB_TEAM_WORKER_LAUNCH_ARGS = "--dangerously-skip-permissions"/);
      // And the resolved claude-native bypass flag must reach the spawn argv.
      assert.match(tmuxLog, /--dangerously-skip-permissions/);
      // claude binary is spawned directly (no omb --leader-cli wrapper).
      assert.match(tmuxLog, /'claude'/);
    });
  });

  it("auto-dismisses detached-session trust prompts before returning", async () => {
    await withTempDir("omb-switch-cli-launch-detached-trust-", async (cwd) => {
      const fakeBin = join(cwd, "bin");
      const logPath = join(cwd, "tmux.log");
      const trustClearedPath = join(cwd, "trust-cleared");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  new-session)
    printf 'demo-detached\t%%55\n'
    ;;
  display-message)
    if [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%55" ]; then
      printf '0\t12345\tnode\n'
    else
      printf '\n'
    fi
    ;;
  capture-pane)
    if [ -f "${trustClearedPath}" ]; then
      printf '❯ \n'
    else
      cat <<'EOF'
Quick safety check: Is this a project you created or one you trust?
❯ 1. Yes, I trust this folder
2. No, exit
Enter to confirm · Esc to cancel
EOF
    fi
    ;;
  send-keys)
    touch "${trustClearedPath}"
    ;;
  *)
    ;;
esac
exit 0
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const previousPath = process.env.PATH;
      process.env.PATH = `${fakeBin}:${previousPath || ""}`;
      try {
        const result = await launchDetachedHandoffSession({
          cwd,
          to: "claude",
          prompt: "take over safely",
          handoffId: "handoff-test-detached-trust",
          leaderLaunchArgs: ["--madmax"],
        });
        assert.match(result.launchCommand, /^tmux attach -t /);
      } finally {
        if (typeof previousPath === "string") process.env.PATH = previousPath;
        else delete process.env.PATH;
      }

      const tmuxLog = await readFile(logPath, "utf-8");
      assert.match(tmuxLog, /capture-pane -t %55 -p/);
      assert.match(tmuxLog, /send-keys -t %55 C-m/);
    });
  });

  it("prefers same-session tmux takeover when current client context is available", async () => {
    await withTempDir("omb-switch-cli-same-session-", async (cwd) => {
      const fakeBin = join(cwd, "bin");
      const logPath = join(cwd, "tmux.log");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  display-message)
    if [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%42" ]; then
      printf 'demo\t3\t%%42\n'
    elif [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%77" ]; then
      printf '0\t12345\tnode\n'
    else
      printf '\n'
    fi
    ;;
  new-window)
    printf '7\t%%77\n'
    ;;
  capture-pane)
    printf '❯ \n'
    ;;
  select-window)
    ;;
  *)
    ;;
 esac
exit 0
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const previousPath = process.env.PATH;
      const previousTmux = process.env.TMUX;
      const previousTmuxPane = process.env.TMUX_PANE;
      const previousCountdown = process.env.OMB_SWITCH_COUNTDOWN_MS;
      process.env.PATH = `${fakeBin}:${previousPath || ""}`;
      process.env.TMUX = "tmux,123,0";
      process.env.TMUX_PANE = "%42";
      process.env.OMB_SWITCH_COUNTDOWN_MS = "0";
      try {
        const result = await launchHandoffSession({
          cwd,
          to: "codex",
          prompt: "take over safely",
          handoffId: "handoff-test-2",
          leaderLaunchArgs: ["--madmax"],
        });
        assert.equal(result.sameTmuxSession, true);
        assert.equal(result.sessionName, "demo");
        assert.equal(result.oldWindowTarget, "demo:3");
        assert.equal(result.newWindowTarget, "demo:7");
        assert.equal(result.launchCommand, "tmux select-window -t demo:7");
      } finally {
        if (typeof previousPath === "string") process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTmux === "string") process.env.TMUX = previousTmux;
        else delete process.env.TMUX;
        if (typeof previousTmuxPane === "string") process.env.TMUX_PANE = previousTmuxPane;
        else delete process.env.TMUX_PANE;
        if (typeof previousCountdown === "string") process.env.OMB_SWITCH_COUNTDOWN_MS = previousCountdown;
        else delete process.env.OMB_SWITCH_COUNTDOWN_MS;
      }

      const tmuxLog = await readFile(logPath, "utf-8");
      assert.match(tmuxLog, /display-message -p -t %42/);
      assert.match(tmuxLog, /new-window -d -P -F/);
      assert.match(tmuxLog, /handoff-codex/);
      assert.match(tmuxLog, /--madmax/);
      assert.match(tmuxLog, /display-message -t %42 -- codex ready in demo:7; switching current tmux session now/);
      assert.match(tmuxLog, /select-window -t demo:7/);
    });
  });

  it("auto-dismisses same-session trust prompts before selecting the new window", async () => {
    await withTempDir("omb-switch-cli-same-session-trust-", async (cwd) => {
      const fakeBin = join(cwd, "bin");
      const logPath = join(cwd, "tmux.log");
      const trustClearedPath = join(cwd, "trust-cleared");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  display-message)
    if [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%42" ]; then
      printf 'demo\t3\t%%42\n'
    elif [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%77" ]; then
      printf '0\t12345\tnode\n'
    else
      printf '\n'
    fi
    ;;
  new-window)
    printf '7\t%%77\n'
    ;;
  capture-pane)
    if [ -f "${trustClearedPath}" ]; then
      printf '❯ \n'
    else
      cat <<'EOF'
Quick safety check: Is this a project you created or one you trust?
❯ 1. Yes, I trust this folder
2. No, exit
Enter to confirm · Esc to cancel
EOF
    fi
    ;;
  send-keys)
    touch "${trustClearedPath}"
    ;;
  select-window)
    ;;
  *)
    ;;
 esac
exit 0
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const previousPath = process.env.PATH;
      const previousTmux = process.env.TMUX;
      const previousTmuxPane = process.env.TMUX_PANE;
      const previousCountdown = process.env.OMB_SWITCH_COUNTDOWN_MS;
      process.env.PATH = `${fakeBin}:${previousPath || ""}`;
      process.env.TMUX = "tmux,123,0";
      process.env.TMUX_PANE = "%42";
      process.env.OMB_SWITCH_COUNTDOWN_MS = "0";
      try {
        const result = await launchHandoffSession({
          cwd,
          to: "claude",
          prompt: "take over safely",
          handoffId: "handoff-test-same-session-trust",
          leaderLaunchArgs: ["--madmax"],
        });
        assert.equal(result.sameTmuxSession, true);
        assert.equal(result.newWindowTarget, "demo:7");
      } finally {
        if (typeof previousPath === "string") process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTmux === "string") process.env.TMUX = previousTmux;
        else delete process.env.TMUX;
        if (typeof previousTmuxPane === "string") process.env.TMUX_PANE = previousTmuxPane;
        else delete process.env.TMUX_PANE;
        if (typeof previousCountdown === "string") process.env.OMB_SWITCH_COUNTDOWN_MS = previousCountdown;
        else delete process.env.OMB_SWITCH_COUNTDOWN_MS;
      }

      const tmuxLog = await readFile(logPath, "utf-8");
      assert.match(tmuxLog, /capture-pane -t %77 -p/);
      assert.match(tmuxLog, /send-keys -t %77 C-m/);
      assert.match(tmuxLog, /select-window -t demo:7/);
    });
  });

  it("loads takeover prompt from file via a safe tmux wrapper", async () => {
    await withTempDir("omb-switch-cli-same-session-direct-argv-", async (cwd) => {
      const fakeBin = join(cwd, "bin");
      const logPath = join(cwd, "tmux.log");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  display-message)
    if [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%42" ]; then
      printf 'demo\t3\t%%42\n'
    elif [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%77" ]; then
      printf '0\t12345\tnode\n'
    else
      printf '\n'
    fi
    ;;
  new-window)
    printf '7\t%%77\n'
    ;;
  capture-pane)
    printf '❯ \n'
    ;;
  select-window)
    ;;
  *)
    ;;
 esac
exit 0
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const previousPath = process.env.PATH;
      const previousTmux = process.env.TMUX;
      const previousTmuxPane = process.env.TMUX_PANE;
      const previousCountdown = process.env.OMB_SWITCH_COUNTDOWN_MS;
      const previousSessionId = process.env.OMB_SESSION_ID;
      const previousWorkerArgs = process.env.OMB_TEAM_WORKER_LAUNCH_ARGS;
      process.env.PATH = `${fakeBin}:${previousPath || ""}`;
      process.env.TMUX = "tmux,123,0";
      process.env.TMUX_PANE = "%42";
      process.env.OMB_SWITCH_COUNTDOWN_MS = "0";
      process.env.OMB_SESSION_ID = "omb-interactive-session-42";
      process.env.OMB_TEAM_WORKER_LAUNCH_ARGS = "--dangerously-skip-permissions";
      try {
        await launchHandoffSession({
          cwd,
          to: "claude",
          prompt: "take over safely\nliteral $(uname)\nliteral `whoami`",
          handoffId: "handoff-test-safe-wrapper",
          leaderLaunchArgs: ["--madmax"],
        });
      } finally {
        if (typeof previousPath === "string") process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTmux === "string") process.env.TMUX = previousTmux;
        else delete process.env.TMUX;
        if (typeof previousTmuxPane === "string") process.env.TMUX_PANE = previousTmuxPane;
        else delete process.env.TMUX_PANE;
        if (typeof previousCountdown === "string") process.env.OMB_SWITCH_COUNTDOWN_MS = previousCountdown;
        else delete process.env.OMB_SWITCH_COUNTDOWN_MS;
        if (typeof previousSessionId === "string") process.env.OMB_SESSION_ID = previousSessionId;
        else delete process.env.OMB_SESSION_ID;
        if (typeof previousWorkerArgs === "string") process.env.OMB_TEAM_WORKER_LAUNCH_ARGS = previousWorkerArgs;
        else delete process.env.OMB_TEAM_WORKER_LAUNCH_ARGS;
      }

      const tmuxLog = await readFile(logPath, "utf-8");
      assert.match(tmuxLog, /new-window -d -P -F/);
      assert.match(tmuxLog, /node' '-e'|node" "-e"|node\s+'-e'/);
      assert.match(tmuxLog, /handoff-test-safe-wrapper-takeover-prompt\.md/);
      assert.match(tmuxLog, /load-buffer -b omb-switch-/);
      assert.match(tmuxLog, /paste-buffer -d -b omb-switch-/);
      assert.doesNotMatch(tmuxLog, /literal \$\(uname\)/);
      assert.doesNotMatch(tmuxLog, /literal `whoami`/);
      assert.doesNotMatch(tmuxLog, /bash -lc/);
      assert.doesNotMatch(tmuxLog, /\$\(cat /);
      // Interactive (same-session) takeover must propagate session env into the spawned claude wrapper:
      assert.match(tmuxLog, /env\.OMB_SESSION_ID = "omb-interactive-session-42"/);
      assert.match(tmuxLog, /env\.OMB_TEAM_WORKER_LAUNCH_ARGS = "--dangerously-skip-permissions"/);
      // The claude-native bypass flag must reach the spawn argv (translated from --madmax):
      assert.match(tmuxLog, /--dangerously-skip-permissions/);
    });
  });

  it("does not fall back to detached launch after same-session tmux side effects already occurred", async () => {
    await withTempDir("omb-switch-cli-same-session-side-effect-failure-", async (cwd) => {
      const fakeBin = join(cwd, "bin");
      const logPath = join(cwd, "tmux.log");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  display-message)
    if [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%42" ]; then
      printf 'demo\t3\t%%42\n'
    elif [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%77" ]; then
      printf '1\t12345\texited\n'
    else
      printf '\n'
    fi
    ;;
  new-window)
    printf '7\t%%77\n'
    ;;
  new-session)
    printf 'detached-should-not-happen\n'
    ;;
  *)
    ;;
 esac
exit 0
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const previousPath = process.env.PATH;
      const previousTmux = process.env.TMUX;
      const previousTmuxPane = process.env.TMUX_PANE;
      const previousCountdown = process.env.OMB_SWITCH_COUNTDOWN_MS;
      process.env.PATH = `${fakeBin}:${previousPath || ""}`;
      process.env.TMUX = "tmux,123,0";
      process.env.TMUX_PANE = "%42";
      process.env.OMB_SWITCH_COUNTDOWN_MS = "0";
      try {
        await assert.rejects(
          () => launchHandoffSession({
            cwd,
            to: "codex",
            prompt: "take over safely",
            handoffId: "handoff-test-side-effect-failure",
            leaderLaunchArgs: ["--madmax"],
          }),
          /same-session tmux takeover created demo:7 but did not complete automatic switch\. Cleaned orphan window demo:7\./i,
        );
      } finally {
        if (typeof previousPath === "string") process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTmux === "string") process.env.TMUX = previousTmux;
        else delete process.env.TMUX;
        if (typeof previousTmuxPane === "string") process.env.TMUX_PANE = previousTmuxPane;
        else delete process.env.TMUX_PANE;
        if (typeof previousCountdown === "string") process.env.OMB_SWITCH_COUNTDOWN_MS = previousCountdown;
        else delete process.env.OMB_SWITCH_COUNTDOWN_MS;
      }

      const tmuxLog = await readFile(logPath, "utf-8");
      assert.match(tmuxLog, /new-window -d -P -F/);
      assert.match(tmuxLog, /kill-window -t demo:7/);
      assert.doesNotMatch(tmuxLog, /new-session/);
    });
  });

  it("falls back to detached launch when same-session takeover fails before creating tmux side effects", async () => {
    await withTempDir("omb-switch-cli-same-session-fallback-", async (cwd) => {
      const fakeBin = join(cwd, "bin");
      const logPath = join(cwd, "tmux.log");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  display-message)
    if [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%42" ]; then
      printf 'demo\t3\t%%42\n'
      exit 0
    fi
    printf '\n'
    exit 0
    ;;
  new-window)
    printf 'boom\n' >&2
    exit 1
    ;;
  new-session)
    exit 0
    ;;
  *)
    exit 0
    ;;
 esac
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const previousPath = process.env.PATH;
      const previousTmux = process.env.TMUX;
      const previousTmuxPane = process.env.TMUX_PANE;
      process.env.PATH = `${fakeBin}:${previousPath || ""}`;
      process.env.TMUX = "tmux,123,0";
      process.env.TMUX_PANE = "%42";
      try {
        const result = await launchHandoffSession({
          cwd,
          to: "codex",
          prompt: "take over safely",
          handoffId: "handoff-test-fallback-before-side-effects",
          leaderLaunchArgs: ["--madmax"],
        });
        assert.notEqual(result.sameTmuxSession, true);
        assert.match(result.launchCommand, /^tmux attach -t /);
      } finally {
        if (typeof previousPath === "string") process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTmux === "string") process.env.TMUX = previousTmux;
        else delete process.env.TMUX;
        if (typeof previousTmuxPane === "string") process.env.TMUX_PANE = previousTmuxPane;
        else delete process.env.TMUX_PANE;
      }

      const tmuxLog = await readFile(logPath, "utf-8");
      assert.match(tmuxLog, /new-window -d -P -F/);
      assert.match(tmuxLog, /new-session -d -P -F/);
    });
  });

  it("records same-session takeover metadata when launcher reports current-session switch", async () => {
    await withTempDir("omb-switch-cli-same-session-state-", async (cwd) => {
      const lines: string[] = [];
      await switchCommand(["--to", "codex", "--task", "continue tests", "--launch"], {
        cwd,
        env: { ...process.env, OMB_SESSION_ID: "old-session-1" },
        stdout: (line) => lines.push(line),
        launch: async () => ({
          sessionId: "new-session-2",
          sessionName: "demo",
          takeoverPromptPath: join(cwd, ".omb", "handoffs", "takeover.md"),
          launchCommand: "tmux select-window -t demo:7",
          sameTmuxSession: true,
          oldWindowTarget: "demo:3",
          newWindowTarget: "demo:7",
        }),
      });

      const output = lines.join("\n");
      assert.match(output, /Current tmux session switched to new codex window demo:7/);
      assert.match(output, /Previous leader window preserved at demo:3/);
      const state = JSON.parse(await readFile(join(cwd, ".omb", "state", "leader-lock.json"), "utf-8"));
      assert.equal(state.same_tmux_session, true);
      assert.equal(state.old_window_target, "demo:3");
      assert.equal(state.new_window_target, "demo:7");
      assert.equal(state.launch_command, "tmux select-window -t demo:7");
    });
  });

  it("uses latest handoff when requested and rejects provider mismatch", async () => {
    await withTempDir("omb-switch-cli-latest-", async (cwd) => {
      assert.equal(runOmb(cwd, ["handoff", "--to", "claude"]).status, 0);
      const ok = runOmb(cwd, ["switch", "--to", "claude", "--handoff", "latest", "--dry-run"]);
      assert.equal(ok.status, 0, ok.stderr || ok.stdout);
      assert.match(ok.stdout, /Selected handoff: handoff-/);

      const mismatch = runOmb(cwd, ["switch", "--to", "codex", "--handoff", "latest", "--dry-run"]);
      assert.equal(mismatch.status, 1);
      assert.match(mismatch.stderr, /targets claude, not codex/);
    });
  });

  it("status reports no switch or current switch state", async () => {
    await withTempDir("omb-switch-cli-status-", async (cwd) => {
      const empty = runOmb(cwd, ["switch", "status"]);
      assert.equal(empty.status, 0, empty.stderr || empty.stdout);
      assert.match(empty.stdout, /No provider switch state/);
      assert.equal(runOmb(cwd, ["switch", "--to", "claude"]).status, 0);
      const status = runOmb(cwd, ["switch", "status"]);
      assert.equal(status.status, 0, status.stderr || status.stdout);
      assert.match(status.stdout, /target_leader: claude/);
    });
  });

  it("top-level and local help include switch", async () => {
    await withTempDir("omb-switch-cli-help-", async (cwd) => {
      const top = runOmb(cwd, ["--help"]);
      assert.equal(top.status, 0, top.stderr || top.stdout);
      assert.match(top.stdout, /omb switch/);
      const local = runOmb(cwd, ["switch", "--help"]);
      assert.equal(local.status, 0, local.stderr || local.stdout);
      assert.match(local.stdout, /Usage:\s*omb switch/);
    });
  });
});
