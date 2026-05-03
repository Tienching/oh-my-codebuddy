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

async function installFakeProviderBin(
  binDir: string,
  providerBin: string,
): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await symlink("/bin/echo", join(binDir, providerBin));
}

/**
 * Regression coverage for architect-review M2 (2026-04-30):
 * doctor must ship a provider-aware `checkHooks` so users can detect:
 *   - missing OMB hooks (hooks file absent)
 *   - truncated hooks (one of the 5 canonical events was removed)
 *   - stale pkgRoot (hooks point at a different OMB install)
 *   - claude-specific: a flat `~/.claude/hooks.json` that Claude CLI silently
 *     ignores (the canonical read path is `~/.claude/hooks/hooks.json`)
 *
 * These assertions pin the `[OK] Hooks: ...` / `[!!] Hooks: ...` /
 * `[!!] Hooks (legacy flat path): ...` output contracts so future refactors
 * don't silently regress doctor visibility into the most fragile surface
 * after the claude leader landing.
 */
describe("doctor checkHooks (M2)", { concurrency: false }, () => {
  it("reports [OK] for a fresh claude install at the subdirectory path", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-doctor-hooks-claude-ok-"));
    try {
      const home = join(wd, "home");
      const bin = join(wd, "bin");
      const claudeHome = join(home, ".claude");
      await installFakeProviderBin(bin, "claude");
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
      assert.match(
        doctor.stdout,
        /\[OK\] (?:Claude )?Hooks: 5 OMB events registered at .+\/\.claude\/hooks\/hooks\.json/,
      );
      // Fresh install must NOT report the legacy-flat warning.
      assert.doesNotMatch(doctor.stdout, /Hooks \(legacy flat path\)/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("reports [OK] for fresh codebuddy/codex installs at the flat path", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-doctor-hooks-flat-"));
    try {
      const home = join(wd, "home");
      const bin = join(wd, "bin");
      await installFakeProviderBin(bin, "codebuddy");
      await installFakeProviderBin(bin, "codex");
      const baseEnv = {
        HOME: home,
        CODEBUDDY_HOME: join(home, ".codebuddy"),
        CODEX_HOME: join(home, ".codex"),
        PATH: `${bin}:/usr/bin:/bin`,
      };

      for (const provider of ["codebuddy", "codex"] as const) {
        const setup = runOmb(wd, ["setup", "--provider", provider, "--scope", "user", "--force"], baseEnv);
        if (shouldSkipForSpawnPermissions(setup.error)) return;
        assert.equal(setup.status, 0, setup.stderr || setup.stdout);

        const doctor = runOmb(wd, ["doctor", "--provider", provider], baseEnv);
        assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
        const providerLabel = provider === "codex" ? "Codex" : "CodeBuddy";
        const expectedPath =
          provider === "codex"
            ? /\.codex\/hooks\.json/
            : /\.codebuddy\/hooks\.json/;
        const hooksRegex = new RegExp(
          String.raw`\[OK\] (?:${providerLabel} )?Hooks: 5 OMB events registered at .+${expectedPath.source}`,
        );
        assert.match(
          doctor.stdout,
          hooksRegex,
          `expected ${providerLabel} hooks OK message; got:\n${doctor.stdout}`,
        );
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("warns when a claude install also has a flat ~/.claude/hooks.json (silently-ignored path)", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-doctor-hooks-claude-flat-"));
    try {
      const home = join(wd, "home");
      const bin = join(wd, "bin");
      const claudeHome = join(home, ".claude");
      await installFakeProviderBin(bin, "claude");
      const env = {
        HOME: home,
        CLAUDE_HOME: claudeHome,
        PATH: `${bin}:/usr/bin:/bin`,
      };

      const setup = runOmb(wd, ["setup", "--provider", "claude", "--scope", "user", "--force"], env);
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0);

      // Simulate a legacy OMB install or a stray user edit leaving a flat
      // hooks.json alongside the canonical subdirectory file.
      const subdirHooks = await readFile(join(claudeHome, "hooks", "hooks.json"), "utf-8");
      await writeFile(join(claudeHome, "hooks.json"), subdirHooks);

      const doctor = runOmb(wd, ["doctor", "--provider", "claude"], env);
      assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
      // Primary hooks check still passes (canonical subdir file is intact)...
      assert.match(doctor.stdout, /\[OK\] (?:Claude )?Hooks: 5 OMB events registered/);
      // ...but a new warning flags the legacy flat file.
      assert.match(
        doctor.stdout,
        /\[!!\] (?:Claude )?Hooks \(legacy flat path\): .+\/\.claude\/hooks\.json exists but Claude CLI does not read it/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("warns when a hooks.json exists but an OMB event is missing", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-doctor-hooks-missing-event-"));
    try {
      const home = join(wd, "home");
      const bin = join(wd, "bin");
      const claudeHome = join(home, ".claude");
      await installFakeProviderBin(bin, "claude");
      const env = {
        HOME: home,
        CLAUDE_HOME: claudeHome,
        PATH: `${bin}:/usr/bin:/bin`,
      };

      const setup = runOmb(wd, ["setup", "--provider", "claude", "--scope", "user", "--force"], env);
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0);

      const hooksPath = join(claudeHome, "hooks", "hooks.json");
      const hooks = JSON.parse(await readFile(hooksPath, "utf-8")) as {
        hooks?: Record<string, unknown>;
      };
      assert.ok(hooks.hooks, "precondition: hooks map exists");
      delete hooks.hooks.SessionStart;
      await writeFile(hooksPath, JSON.stringify(hooks, null, 2));

      const doctor = runOmb(wd, ["doctor", "--provider", "claude"], env);
      assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
      assert.match(
        doctor.stdout,
        /\[!!\] (?:Claude )?Hooks: Claude hooks missing OMB events: SessionStart/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("warns when hooks point at a stale pkgRoot (wrong native-hook.js path)", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-doctor-hooks-stale-"));
    try {
      const home = join(wd, "home");
      const bin = join(wd, "bin");
      await installFakeProviderBin(bin, "codebuddy");
      const env = {
        HOME: home,
        CODEBUDDY_HOME: join(home, ".codebuddy"),
        PATH: `${bin}:/usr/bin:/bin`,
      };

      const setup = runOmb(wd, ["setup", "--provider", "codebuddy", "--scope", "user", "--force"], env);
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0);

      const hooksPath = join(home, ".codebuddy", "hooks.json");
      const original = await readFile(hooksPath, "utf-8");
      // Rewrite every managed command to a fake pkgRoot. The doctor should
      // notice: every OMB event still has an entry, but none of them point
      // at the real pkgRoot anymore.
      const parsed = JSON.parse(original) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      };
      const FAKE_ROOT = "/tmp/fake-stale-pkgroot";
      const eventMap = parsed.hooks ?? {};
      for (const entries of Object.values(eventMap)) {
        for (const entry of entries) {
          for (const hook of entry.hooks ?? []) {
            if (typeof hook.command === "string") {
              hook.command = hook.command.replace(
                /node "[^"]+"/,
                `node "${FAKE_ROOT}/dist/scripts/codebuddy-native-hook.js"`,
              );
            }
          }
        }
      }
      const rewritten = JSON.stringify(parsed, null, 2);
      assert.notEqual(rewritten, original, "rewrite must actually change the file");
      assert.ok(
        rewritten.includes("/tmp/fake-stale-pkgroot/"),
        "rewritten content must reference fake pkgRoot",
      );
      await writeFile(hooksPath, rewritten);

      const doctor = runOmb(wd, ["doctor", "--provider", "codebuddy"], env);
      assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
      assert.match(
        doctor.stdout,
        /\[!!\] (?:CodeBuddy )?Hooks: CodeBuddy hooks present but do not reference current pkgRoot/,
      );
      // All 5 events should be flagged stale.
      assert.match(
        doctor.stdout,
        /stale events:.*SessionStart.*PreToolUse.*PostToolUse.*UserPromptSubmit.*Stop/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("warns when hooks.json is missing entirely (not yet set up)", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-doctor-hooks-missing-"));
    try {
      const home = join(wd, "home");
      const bin = join(wd, "bin");
      const claudeHome = join(home, ".claude");
      await installFakeProviderBin(bin, "claude");
      // Create claude home but no hooks/ subdirectory, simulating a partial
      // install where the user touched `.claude/` for another tool but never
      // ran `omb setup --provider claude`.
      await mkdir(claudeHome, { recursive: true });
      const env = {
        HOME: home,
        CLAUDE_HOME: claudeHome,
        PATH: `${bin}:/usr/bin:/bin`,
      };

      const doctor = runOmb(wd, ["doctor", "--provider", "claude"], env);
      assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
      assert.match(
        doctor.stdout,
        /\[!!\] (?:Claude )?Hooks: .+\/\.claude\/hooks\/hooks\.json not found/,
      );
      // Negative: never report the subdirectory file as "[OK] 5 OMB events"
      // when it doesn't exist.
      assert.doesNotMatch(doctor.stdout, /\[OK\] (?:Claude )?Hooks: 5 OMB events/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
