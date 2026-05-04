import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

/**
 * End-to-end regression coverage for M3 stale-provider detection wired
 * through setup and doctor. Pure-function coverage is in
 * `src/setup/__tests__/stale-provider.test.ts`; these tests pin the
 * user-visible output contract.
 */
describe("M3 provider switch residue (setup + doctor warnings)", { concurrency: false }, () => {
  it("setup --provider claude warns after a prior --provider codebuddy install in project scope", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-m3-switch-setup-"));
    try {
      const home = join(wd, "home");
      const proj = join(wd, "proj");
      await mkdir(proj, { recursive: true });
      await mkdir(home, { recursive: true });
      // Need a git repo for project-scope setup to pass its guards.
      const gitInit = spawnSync("git", ["init", "-q"], { cwd: proj });
      if (gitInit.status !== 0) return; // no git → skip

      const env = { HOME: home };

      const initial = runOmb(
        proj,
        ["setup", "--provider", "codebuddy", "--scope", "project", "--yes"],
        env,
      );
      if (shouldSkipForSpawnPermissions(initial.error)) return;
      assert.equal(initial.status, 0, initial.stderr || initial.stdout);
      // First setup sees no residue.
      assert.doesNotMatch(initial.stdout, /stale provider residue/i);

      // Switch to claude without uninstalling codebuddy.
      const switched = runOmb(
        proj,
        [
          "setup",
          "--provider",
          "claude",
          "--scope",
          "project",
          "--yes",
          "--force",
        ],
        env,
      );
      assert.equal(switched.status, 0, switched.stderr || switched.stdout);
      assert.match(
        switched.stdout,
        /stale provider residue detected from a previous setup: \.codebuddy\//,
      );
      assert.match(
        switched.stdout,
        /omb uninstall --provider codebuddy --scope project/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("doctor flags [!!] Stale provider residue when a prior provider still has OMB artifacts", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-m3-switch-doctor-"));
    try {
      const home = join(wd, "home");
      const proj = join(wd, "proj");
      await mkdir(proj, { recursive: true });
      await mkdir(home, { recursive: true });
      const gitInit = spawnSync("git", ["init", "-q"], { cwd: proj });
      if (gitInit.status !== 0) return;

      const env = { HOME: home };

      const initial = runOmb(
        proj,
        ["setup", "--provider", "codebuddy", "--scope", "project", "--yes"],
        env,
      );
      if (shouldSkipForSpawnPermissions(initial.error)) return;
      assert.equal(initial.status, 0, initial.stderr || initial.stdout);

      const switched = runOmb(
        proj,
        [
          "setup",
          "--provider",
          "claude",
          "--scope",
          "project",
          "--yes",
          "--force",
        ],
        env,
      );
      assert.equal(switched.status, 0);

      // Doctor reads the persisted provider (claude) and notices .codebuddy/
      // residue.
      const doctor = runOmb(proj, ["doctor"], env);
      assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
      assert.match(doctor.stdout, /Resolved setup provider: claude/);
      assert.match(
        doctor.stdout,
        /\[!!\] Stale provider residue: \.codebuddy\/ contains OMB artifacts/,
      );
      assert.match(
        doctor.stdout,
        /omb uninstall --provider codebuddy --scope project/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("doctor does NOT flag residue when setup was only ever run with one provider", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-m3-no-residue-"));
    try {
      const home = join(wd, "home");
      const proj = join(wd, "proj");
      await mkdir(proj, { recursive: true });
      await mkdir(home, { recursive: true });
      const gitInit = spawnSync("git", ["init", "-q"], { cwd: proj });
      if (gitInit.status !== 0) return;

      const env = { HOME: home };

      const setup = runOmb(
        proj,
        ["setup", "--provider", "claude", "--scope", "project", "--yes"],
        env,
      );
      if (shouldSkipForSpawnPermissions(setup.error)) return;
      assert.equal(setup.status, 0, setup.stderr || setup.stdout);

      const doctor = runOmb(proj, ["doctor"], env);
      assert.equal(doctor.status, 0);
      // Negative: never emit the stale-residue warning on a clean install.
      assert.doesNotMatch(doctor.stdout, /Stale provider residue/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("doctor does NOT flag residue in user-scope setups even if ~/.codebuddy/ exists", async () => {
    // User-scope ~/.<provider>/ dirs legitimately co-exist with non-OMB
    // installs. M3 is project-scope only.
    const wd = await mkdtemp(join(tmpdir(), "omb-m3-user-scope-"));
    try {
      const home = join(wd, "home");
      const proj = join(wd, "proj");
      await mkdir(proj, { recursive: true });
      await mkdir(home, { recursive: true });
      const gitInit = spawnSync("git", ["init", "-q"], { cwd: proj });
      if (gitInit.status !== 0) return;

      const env = {
        HOME: home,
        CODEBUDDY_HOME: join(home, ".codebuddy"),
        CLAUDE_HOME: join(home, ".claude"),
      };

      const initial = runOmb(
        proj,
        ["setup", "--provider", "codebuddy", "--scope", "user", "--yes"],
        env,
      );
      if (shouldSkipForSpawnPermissions(initial.error)) return;
      assert.equal(initial.status, 0, initial.stderr || initial.stdout);

      const switched = runOmb(
        proj,
        [
          "setup",
          "--provider",
          "claude",
          "--scope",
          "user",
          "--yes",
          "--force",
        ],
        env,
      );
      assert.equal(switched.status, 0);

      // user-scope switch: setup must NOT print the residue warning.
      assert.doesNotMatch(switched.stdout, /stale provider residue/i);

      const doctor = runOmb(proj, ["doctor", "--provider", "claude"], env);
      assert.equal(doctor.status, 0);
      assert.doesNotMatch(doctor.stdout, /Stale provider residue/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("residue warning disappears after running the suggested uninstall", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-m3-cleanup-"));
    try {
      const home = join(wd, "home");
      const proj = join(wd, "proj");
      await mkdir(proj, { recursive: true });
      await mkdir(home, { recursive: true });
      const gitInit = spawnSync("git", ["init", "-q"], { cwd: proj });
      if (gitInit.status !== 0) return;

      const env = { HOME: home };

      assert.equal(
        runOmb(
          proj,
          ["setup", "--provider", "codebuddy", "--scope", "project", "--yes"],
          env,
        ).status,
        0,
      );
      assert.equal(
        runOmb(
          proj,
          [
            "setup",
            "--provider",
            "claude",
            "--scope",
            "project",
            "--yes",
            "--force",
          ],
          env,
        ).status,
        0,
      );

      // Confirm residue was present.
      const before = runOmb(proj, ["doctor"], env);
      assert.equal(before.status, 0);
      assert.match(before.stdout, /Stale provider residue/);

      // Run suggested cleanup.
      const uninstall = runOmb(
        proj,
        [
          "uninstall",
          "--provider",
          "codebuddy",
          "--scope",
          "project",
          "--yes",
        ],
        env,
      );
      assert.equal(uninstall.status, 0);

      // Doctor no longer flags residue.
      const after = runOmb(proj, ["doctor"], env);
      assert.equal(after.status, 0);
      assert.doesNotMatch(after.stdout, /Stale provider residue/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
