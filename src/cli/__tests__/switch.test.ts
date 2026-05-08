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
      const res = runOmb(cwd, ["switch", "--to", "claude", "--dry-run", "--reason", "provider handoff"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Switch dry run/);
      assert.match(res.stdout, /Would create handoff/);
      assert.match(res.stdout, /omb --leader-cli claude/);
      assert.equal(existsSync(join(cwd, ".omb")), false);
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
      assert.match(tmuxLog, /new-session -d -s /);
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
