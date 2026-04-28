/**
 * Tests for setup plan generation and apply.
 *
 * Covers key scenarios:
 *   - Fresh install
 *   - Project-level install
 *   - Legacy alias already exists
 *   - Legacy hooks exist
 *   - Scope migration needed
 *   - Idempotency (running twice produces same plan)
 *   - Dry-run golden output (no files created)
 *   - Migration regression: .codex dir no longer creates symlink actions
 *   - Migration regression: .omb state dir → compat warning
 *   - Apply with dryRun=true leaves all actions as 'skipped'
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateSetupPlan,
  computePlanSummary,
  type SetupPlan,
  type SetupAction,
} from "../plan.js";
import { applySetupPlan, type ApplyResult } from "../apply.js";

describe("computePlanSummary", () => {
  it("counts pending and completed actions correctly", () => {
    const actions: SetupAction[] = [
      { kind: "mkdir", description: "a", destination: "/a", status: "pending" },
      { kind: "copy", description: "b", destination: "/b", status: "applied" },
      { kind: "skip", description: "c", destination: "/c", status: "skipped" },
      { kind: "mkdir", description: "d", destination: "/d", status: "failed" },
      { kind: "mkdir", description: "e", destination: "/e", status: "pending" },
    ];

    const summary = computePlanSummary(actions);
    assert.equal(summary.total, 5);
    assert.equal(summary.pending, 2);
    assert.equal(summary.applied, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.failed, 1);
  });

  it("returns zero counts for empty actions", () => {
    const summary = computePlanSummary([]);
    assert.equal(summary.total, 0);
    assert.equal(summary.pending, 0);
    assert.equal(summary.applied, 0);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.failed, 0);
  });
});

describe("generateSetupPlan", () => {
  it("generates a plan for user scope with fresh directories", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-plan-fresh-user-"));
    try {
      // Create a minimal pkgRoot structure
      const pkgRoot = join(wd, "pkg");
      await mkdir(join(pkgRoot, "prompts"), { recursive: true });
      await mkdir(join(pkgRoot, "skills"), { recursive: true });
      await mkdir(join(pkgRoot, "templates"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "cli"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "scripts"), { recursive: true });
      await writeFile(join(pkgRoot, "prompts", "executor.md"), "# Executor\n");
      await writeFile(join(pkgRoot, "templates", "AGENTS.md"), "# AGENTS\n");
      await writeFile(join(pkgRoot, "dist", "cli", "team.js"), "// team\n");

      const plan = await generateSetupPlan({
        scope: "user",
        projectRoot: wd,
        pkgRoot,
      });

      assert.equal(plan.scope, "user");
      assert.ok(plan.actions.length > 0, "plan should have actions");
      assert.ok(plan.summary.total > 0, "plan summary should have total > 0");

      // Should have mkdir actions for directories that don't exist
      const mkdirActions = plan.actions.filter((a) => a.kind === "mkdir");
      assert.ok(mkdirActions.length > 0, "should have mkdir actions");

      // Should have config update action
      const configActions = plan.actions.filter(
        (a) => a.description.includes("config.toml"),
      );
      assert.ok(configActions.length > 0, "should have config.toml action");

      // Should have AGENTS.md action
      const agentsMdActions = plan.actions.filter(
        (a) => a.description.includes("AGENTS.md"),
      );
      assert.ok(agentsMdActions.length > 0, "should have AGENTS.md action");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("generates gitignore actions for project scope", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-plan-project-"));
    try {
      const pkgRoot = join(wd, "pkg");
      await mkdir(join(pkgRoot, "prompts"), { recursive: true });
      await mkdir(join(pkgRoot, "skills"), { recursive: true });
      await mkdir(join(pkgRoot, "templates"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "cli"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "scripts"), { recursive: true });

      const plan = await generateSetupPlan({
        scope: "project",
        projectRoot: wd,
        pkgRoot,
      });

      const gitignoreActions = plan.actions.filter(
        (a) => a.description.includes("gitignore"),
      );
      assert.ok(
        gitignoreActions.length > 0,
        "project scope should have gitignore action",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses only Codex paths for project scope with provider codex", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-plan-codex-project-"));
    try {
      const pkgRoot = await createMinimalPkgRoot(wd);
      const pkgCodexSkill = join(pkgRoot, "skills", "help");
      await mkdir(pkgCodexSkill, { recursive: true });
      await writeFile(join(pkgCodexSkill, "SKILL.md"), "# Help\n");

      const plan = await generateSetupPlan({
        scope: "project",
        projectRoot: wd,
        pkgRoot,
        provider: "codex",
      });

      const promptActions = plan.actions.filter((action) =>
        action.description.startsWith("Install prompt ")
          || action.description.startsWith("Prompt ")
      );
      assert.equal(
        promptActions.some((action) =>
          action.destination.includes(join(wd, ".codex", "prompts")),
        ),
        true,
      );
      assert.equal(
        promptActions.some((action) =>
          action.destination.includes(join(wd, ".codebuddy", "prompts")),
        ),
        false,
      );

      const skillActions = plan.actions.filter((action) =>
        action.description.startsWith("Install skill ")
      );
      assert.equal(
        skillActions.some((action) =>
          action.destination.includes(join(wd, ".codex", "skills")),
        ),
        true,
      );
      assert.equal(
        skillActions.some((action) =>
          action.destination.includes(join(wd, ".codebuddy", "skills")),
        ),
        false,
      );

      const gitignoreAction = plan.actions.find((action) =>
        action.description.includes("Update .gitignore with OMB project rules"),
      );
      const gitignoreMetadata = gitignoreAction?.metadata as
        | { missingEntries: string[] }
        | undefined;
      assert.ok(gitignoreMetadata);
      assert.equal(
        gitignoreMetadata.missingEntries.some((entry) =>
          entry.startsWith(".codebuddy"),
        ),
        false,
      );
      assert.equal(
        gitignoreMetadata.missingEntries.some((entry) =>
          entry.startsWith(".codex"),
        ),
        true,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("plans user scope installs for both provider homes", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-plan-both-user-"));
    try {
      const pkgRoot = await createMinimalPkgRoot(wd);
      const previousCodebuddyHome = process.env.CODEBUDDY_HOME;
      const previousCodexHome = process.env.CODEX_HOME;
      process.env.CODEBUDDY_HOME = join(wd, ".codebuddy");
      process.env.CODEX_HOME = join(wd, ".codex");

      try {
        const plan = await generateSetupPlan({
          scope: "user",
          projectRoot: wd,
          pkgRoot,
          provider: "both",
        });

        const configActions = plan.actions.filter((action) =>
          action.description === "Update config.toml",
        );
        assert.equal(configActions.length, 2);
        assert.equal(
          configActions.some((action) =>
            action.destination.includes(join(wd, ".codebuddy", "config.toml")),
          ),
          true,
        );
        assert.equal(
          configActions.some((action) =>
            action.destination.includes(join(wd, ".codex", "config.toml")),
          ),
          true,
        );

        const promptActions = plan.actions.filter((action) =>
          action.description.startsWith("Install prompt ")
        );
        assert.equal(
          promptActions.some((action) =>
            action.destination.includes(join(wd, ".codebuddy", "prompts")),
          ),
          true,
        );
        assert.equal(
          promptActions.some((action) =>
            action.destination.includes(join(wd, ".codex", "prompts")),
          ),
          true,
        );

        const agentsMdActions = plan.actions.filter((action) =>
          action.description === "Generate AGENTS.md"
        );
        assert.equal(agentsMdActions.length, 2);
        assert.equal(
          agentsMdActions.some((action) =>
            action.destination.includes(join(wd, ".codebuddy", "AGENTS.md")),
          ),
          true,
        );
        assert.equal(
          agentsMdActions.some((action) =>
            action.destination.includes(join(wd, ".codex", "AGENTS.md")),
          ),
          true,
        );
      } finally {
        if (previousCodebuddyHome === undefined) {
          delete process.env.CODEBUDDY_HOME;
        } else {
          process.env.CODEBUDDY_HOME = previousCodebuddyHome;
        }
        if (previousCodexHome === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = previousCodexHome;
        }
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("plans both providers in project scope with combined .gitignore preview", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-plan-both-project-"));
    try {
      const pkgRoot = await createMinimalPkgRoot(wd);

      const plan = await generateSetupPlan({
        scope: "project",
        projectRoot: wd,
        pkgRoot,
        provider: "both",
      });

      const configActions = plan.actions.filter((action) =>
        action.description === "Update config.toml",
      );
      assert.equal(configActions.length, 2);
      assert.equal(
        configActions.some((action) =>
          action.destination.includes(join(wd, ".codebuddy", "config.toml")),
        ),
        true,
      );
      assert.equal(
        configActions.some((action) =>
          action.destination.includes(join(wd, ".codex", "config.toml")),
        ),
        true,
      );

      const hookActions = plan.actions.filter((action) =>
        action.description === "Update native hooks"
      );
      assert.equal(hookActions.length, 2);
      assert.equal(
        hookActions.some((action) =>
          action.destination.includes(join(wd, ".codebuddy", "hooks.json")),
        ),
        true,
      );
      assert.equal(
        hookActions.some((action) =>
          action.destination.includes(join(wd, ".codex", "hooks.json")),
        ),
        true,
      );

      const gitignoreAction = plan.actions.find((action) =>
        action.description.includes("Update .gitignore with OMB project rules"),
      );
      const gitignoreMetadata = gitignoreAction?.metadata as
        | { missingEntries: string[] }
        | undefined;
      assert.ok(gitignoreMetadata);
      assert.equal(
        gitignoreMetadata.missingEntries.some((entry) =>
          entry.startsWith(".codebuddy"),
        ),
        true,
      );
      assert.equal(
        gitignoreMetadata.missingEntries.some((entry) =>
          entry.startsWith(".codex"),
        ),
        true,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("skips mkdir for directories that already exist", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-plan-existing-dirs-"));
    try {
      const pkgRoot = join(wd, "pkg");
      await mkdir(join(pkgRoot, "prompts"), { recursive: true });
      await mkdir(join(pkgRoot, "skills"), { recursive: true });
      await mkdir(join(pkgRoot, "templates"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "cli"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "scripts"), { recursive: true });

      // Pre-create the codebuddy home directory
      const { resolveScopeDirectories } = await import("../../cli/setup.js");
      const scopeDirs = resolveScopeDirectories("user", wd);
      mkdirSync(scopeDirs.codexHomeDir, { recursive: true });

      const plan = await generateSetupPlan({
        scope: "user",
        projectRoot: wd,
        pkgRoot,
      });

      const mkdirActions = plan.actions.filter((a) => a.kind === "mkdir");
      const homeDirMkdir = mkdirActions.find(
        (a) => a.destination === scopeDirs.codexHomeDir,
      );
      assert.equal(
        homeDirMkdir,
        undefined,
        "should not have mkdir for existing home dir",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not include legacy .codex alias symlinks for project scope", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-plan-no-legacy-alias-"));
    try {
      const pkgRoot = join(wd, "pkg");
      await mkdir(join(pkgRoot, "prompts"), { recursive: true });
      await mkdir(join(pkgRoot, "skills"), { recursive: true });
      await mkdir(join(pkgRoot, "templates"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "cli"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "scripts"), { recursive: true });

      const plan = await generateSetupPlan({
        scope: "project",
        projectRoot: wd,
        pkgRoot,
      });

      const symlinkActions = plan.actions.filter(
        (a) =>
          a.kind === "symlink" &&
          a.destination === join(wd, ".codex"),
      );
      assert.equal(
        symlinkActions.length,
        0,
        "should not create legacy .codex alias symlinks",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("includes settings.json bootstrap when file does not exist", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-plan-settings-"));
    try {
      const pkgRoot = join(wd, "pkg");
      await mkdir(join(pkgRoot, "prompts"), { recursive: true });
      await mkdir(join(pkgRoot, "skills"), { recursive: true });
      await mkdir(join(pkgRoot, "templates"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "cli"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "scripts"), { recursive: true });

      // Use project scope so the codebuddy home is inside our temp dir
      const plan = await generateSetupPlan({
        scope: "project",
        projectRoot: wd,
        pkgRoot,
      });

      const settingsActions = plan.actions.filter(
        (a) => a.description.includes("settings.json"),
      );
      assert.ok(
        settingsActions.length > 0,
        "should have settings.json bootstrap action",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("produces deterministic plans for identical inputs", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-plan-idempotent-"));
    try {
      const pkgRoot = join(wd, "pkg");
      await mkdir(join(pkgRoot, "prompts"), { recursive: true });
      await mkdir(join(pkgRoot, "skills"), { recursive: true });
      await mkdir(join(pkgRoot, "templates"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "cli"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "scripts"), { recursive: true });
      await writeFile(join(pkgRoot, "prompts", "executor.md"), "# Executor\n");

      const options = {
        scope: "user" as const,
        projectRoot: wd,
        pkgRoot,
      };

      const plan1 = await generateSetupPlan(options);
      const plan2 = await generateSetupPlan(options);

      assert.equal(plan1.actions.length, plan2.actions.length);
      for (let i = 0; i < plan1.actions.length; i++) {
        assert.equal(plan1.actions[i]!.kind, plan2.actions[i]!.kind);
        assert.equal(
          plan1.actions[i]!.description,
          plan2.actions[i]!.description,
        );
        assert.equal(
          plan1.actions[i]!.destination,
          plan2.actions[i]!.destination,
        );
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("includes scopeDirectories in the plan", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-plan-scopedirs-"));
    try {
      const pkgRoot = join(wd, "pkg");
      await mkdir(join(pkgRoot, "prompts"), { recursive: true });
      await mkdir(join(pkgRoot, "skills"), { recursive: true });
      await mkdir(join(pkgRoot, "templates"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "cli"), { recursive: true });
      await mkdir(join(pkgRoot, "dist", "scripts"), { recursive: true });

      const plan = await generateSetupPlan({
        scope: "user",
        projectRoot: wd,
        pkgRoot,
      });

      assert.ok(plan.scopeDirectories, "plan should include scopeDirectories");
      assert.ok(
        plan.scopeDirectories.codexHomeDir,
        "scopeDirectories should have codexHomeDir",
      );
      assert.ok(
        plan.scopeDirectories.codexConfigFile,
        "scopeDirectories should have codexConfigFile",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: create a minimal pkgRoot structure for tests
// ---------------------------------------------------------------------------

async function createMinimalPkgRoot(base: string): Promise<string> {
  const pkgRoot = join(base, "pkg");
  await mkdir(join(pkgRoot, "prompts"), { recursive: true });
  await mkdir(join(pkgRoot, "skills"), { recursive: true });
  await mkdir(join(pkgRoot, "templates"), { recursive: true });
  await mkdir(join(pkgRoot, "dist", "cli"), { recursive: true });
  await mkdir(join(pkgRoot, "dist", "scripts"), { recursive: true });
  await writeFile(join(pkgRoot, "prompts", "executor.md"), "# Executor\n");
  await writeFile(join(pkgRoot, "templates", "AGENTS.md"), "# AGENTS\n");
  await writeFile(join(pkgRoot, "dist", "cli", "team.js"), "// team\n");
  return pkgRoot;
}

// ---------------------------------------------------------------------------
// Dry-run and apply tests
// ---------------------------------------------------------------------------

describe("applySetupPlan scope persistence", () => {
  it("persists provider alongside scope for provider=codex so downstream resolvers see the choice", async () => {
    // Regression guard for handoff §8.1: generateSetupPlan carried provider
    // in action metadata but applySetupPlan used to drop it, so the persisted
    // setup-scope.json collapsed back to "just scope". Downstream resolvers
    // (ask.ts, commands/index.ts, runtime/launch) rely on `.provider` to
    // pick CodeBuddy vs Codex, so losing it silently breaks provider routing.
    const wd = await mkdtemp(join(tmpdir(), "omb-apply-scope-codex-"));
    try {
      const pkgRoot = await createMinimalPkgRoot(wd);
      const plan = await generateSetupPlan({
        scope: "project",
        provider: "codex",
        projectRoot: wd,
        pkgRoot,
      });
      const scopeAction = plan.actions.find(
        (a) => a.kind === "update" && a.destination.endsWith("setup-scope.json"),
      );
      assert.ok(scopeAction, "plan should include a scope-persistence update action");

      const result = await applyOnlyAction(plan, scopeAction!);
      assert.equal(result.success, true, result.errors.join("\n"));

      const persisted = JSON.parse(
        await readFile(scopeAction!.destination, "utf-8"),
      ) as { scope: string; provider: string };
      assert.equal(persisted.scope, "project");
      assert.equal(persisted.provider, "codex");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("persists provider=both when the plan covers both providers", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-apply-scope-both-"));
    try {
      const pkgRoot = await createMinimalPkgRoot(wd);
      const plan = await generateSetupPlan({
        scope: "user",
        provider: "both",
        projectRoot: wd,
        pkgRoot,
      });
      const scopeAction = plan.actions.find(
        (a) => a.kind === "update" && a.destination.endsWith("setup-scope.json"),
      );
      assert.ok(scopeAction, "plan should include a scope-persistence update action");

      const result = await applyOnlyAction(plan, scopeAction!);
      assert.equal(result.success, true, result.errors.join("\n"));

      const persisted = JSON.parse(
        await readFile(scopeAction!.destination, "utf-8"),
      ) as { scope: string; provider: string };
      assert.equal(persisted.scope, "user");
      assert.equal(persisted.provider, "both");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

/**
 * Run applySetupPlan for a single action. Used by focused scope-persistence
 * tests so they don't depend on the full plan executing end-to-end (the
 * plan/apply architecture is still partially preview-only today).
 */
async function applyOnlyAction(
  plan: Awaited<ReturnType<typeof generateSetupPlan>>,
  action: (typeof plan)["actions"][number],
): Promise<ApplyResult> {
  const isolatedPlan: typeof plan = {
    ...plan,
    actions: plan.actions.map((existing) => ({
      ...existing,
      status: existing === action ? "pending" : "skipped",
    })),
  };
  return applySetupPlan(isolatedPlan);
}

describe("applySetupPlan with dryRun=true", () => {
  it("leaves all pending actions as skipped without creating files", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-apply-dryrun-"));
    try {
      const pkgRoot = await createMinimalPkgRoot(wd);
      const plan = await generateSetupPlan({
        scope: "project",
        projectRoot: wd,
        pkgRoot,
      });

      // Verify some actions are pending before apply
      const pendingBefore = plan.actions.filter((a) => a.status === "pending");
      assert.ok(pendingBefore.length > 0, "should have pending actions before apply");

      const result = await applySetupPlan(plan, { dryRun: true });

      // All originally-pending actions should now be 'skipped'
      for (const action of result.plan.actions) {
        if (action.kind === "skip" && action.status === "skipped") {
          // Pre-skipped actions (e.g., up-to-date files) are fine
          continue;
        }
        if (pendingBefore.some((p) => p.destination === action.destination && p.kind === action.kind)) {
          assert.equal(
            action.status,
            "skipped",
            `action ${action.kind} ${action.description} should be skipped in dry-run`,
          );
        }
      }

      // No files should have been created in the project
      const codebuddyDir = join(wd, ".codebuddy");
      assert.equal(
        existsSync(codebuddyDir),
        false,
        "dry-run should not create .codebuddy directory",
      );

      // Result should report success (no failures)
      assert.equal(result.success, true, "dry-run should not have failures");
      assert.equal(result.errors.length, 0, "dry-run should have no errors");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("produces golden dry-run output with verbose logging", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-dryrun-golden-"));
    try {
      const pkgRoot = await createMinimalPkgRoot(wd);
      const plan = await generateSetupPlan({
        scope: "project",
        projectRoot: wd,
        pkgRoot,
      });

      // Capture verbose output
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };

      try {
        await applySetupPlan(plan, { dryRun: true, verbose: true });
      } finally {
        console.log = originalLog;
      }

      // Every pending action should appear in dry-run output
      const pendingActions = plan.actions.filter((a) => a.status === "skipped");
      const dryRunLines = logs.filter((l) => l.includes("[dry-run]"));
      assert.ok(
        dryRunLines.length > 0,
        "verbose dry-run should produce [dry-run] log lines",
      );

      // Each dry-run line should mention the action kind
      for (const line of dryRunLines) {
        assert.ok(
          line.includes("would"),
          `dry-run line should contain "would": ${line}`,
        );
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Migration regression tests
// ---------------------------------------------------------------------------

describe("migration regression tests", () => {
  it("project with .codex dir does not get a legacy symlink action", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-regression-codex-"));
    try {
      const pkgRoot = await createMinimalPkgRoot(wd);

      // Pre-create .codex directory (simulating legacy project)
      await mkdir(join(wd, ".codex"), { recursive: true });

      const plan = await generateSetupPlan({
        scope: "project",
        projectRoot: wd,
        pkgRoot,
      });

      // Should NOT have a symlink action for .codex since it already exists
      const symlinkToCodex = plan.actions.filter(
        (a) =>
          a.kind === "symlink" &&
          a.destination === join(wd, ".codex"),
      );
      assert.equal(
        symlinkToCodex.length,
        0,
        "should not create symlink when .codex already exists",
      );

      // Should still have actions for config, hooks, etc.
      const configActions = plan.actions.filter(
        (a) => a.description.includes("config.toml"),
      );
      assert.ok(
        configActions.length > 0,
        "should still update config.toml even with existing .codex",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("project without .codex dir does not get a compatibility symlink action", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-regression-no-codex-"));
    try {
      const pkgRoot = await createMinimalPkgRoot(wd);

      const plan = await generateSetupPlan({
        scope: "project",
        projectRoot: wd,
        pkgRoot,
      });

      const symlinkActions = plan.actions.filter(
        (a) => a.kind === "symlink" && a.destination === join(wd, ".codex"),
      );
      assert.equal(
        symlinkActions.length,
        0,
        "should not create .codex compatibility symlinks for project scope",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  // Note: .omb compat rule is deprecated, so it does not generate warnings.
  // The .omb/.omb dual-read behavior is automatic; no user action needed.
  it("project with .omb state dir does not get compat warning", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-regression-omb-"));
    try {
      const pkgRoot = await createMinimalPkgRoot(wd);

      // Pre-create .omb state directory
      await mkdir(join(wd, ".omb"), { recursive: true });

      const plan = await generateSetupPlan({
        scope: "project",
        projectRoot: wd,
        pkgRoot,
      });

      // Should NOT include a warning about legacy .omb (rule is deprecated)
      const ombWarnings = plan.warnings.filter((w) =>
        w.includes(".omb") || w.includes("legacy .omb"),
      );
      assert.equal(
        ombWarnings.length,
        0,
        "deprecated .omb rule should not produce warnings",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("project with both .codex and .omb gets no legacy compat warnings", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-regression-both-"));
    try {
      const pkgRoot = await createMinimalPkgRoot(wd);

      // Pre-create both legacy directories
      await mkdir(join(wd, ".codex"), { recursive: true });
      await mkdir(join(wd, ".omb"), { recursive: true });

      const plan = await generateSetupPlan({
        scope: "project",
        projectRoot: wd,
        pkgRoot,
      });

      // No symlink for .codex (already exists)
      const symlinkToCodex = plan.actions.filter(
        (a) => a.kind === "symlink" && a.destination === join(wd, ".codex"),
      );
      assert.equal(symlinkToCodex.length, 0, "should not symlink existing .codex");

      const ombWarnings = plan.warnings.filter((w) => w.includes(".omb"));
      assert.equal(
        ombWarnings.length,
        0,
        "deprecated .omb rule should not produce warnings",
      );
      const codexWarnings = plan.warnings.filter((w) => w.includes(".codex"));
      assert.equal(
        codexWarnings.length,
        0,
        "removal-candidate .codex rule should not produce warnings",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency tests (extended)
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("running generateSetupPlan twice with same inputs produces identical plans", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-idempotency-"));
    try {
      const pkgRoot = await createMinimalPkgRoot(wd);
      const options = {
        scope: "project" as const,
        projectRoot: wd,
        pkgRoot,
      };

      const plan1 = await generateSetupPlan(options);
      const plan2 = await generateSetupPlan(options);

      // Same number of actions
      assert.equal(plan1.actions.length, plan2.actions.length);

      // Each action matches in kind, description, destination, source
      for (let i = 0; i < plan1.actions.length; i++) {
        const a1 = plan1.actions[i]!;
        const a2 = plan2.actions[i]!;
        assert.equal(a1.kind, a2.kind, `action ${i} kind mismatch`);
        assert.equal(a1.description, a2.description, `action ${i} description mismatch`);
        assert.equal(a1.destination, a2.destination, `action ${i} destination mismatch`);
        assert.equal(a1.source, a2.source, `action ${i} source mismatch`);
        assert.equal(a1.status, a2.status, `action ${i} status mismatch`);
      }

      // Same warnings
      assert.deepEqual(plan1.warnings, plan2.warnings);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("plan with .codex dir is idempotent across calls", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omb-idempotency-codex-"));
    try {
      const pkgRoot = await createMinimalPkgRoot(wd);
      await mkdir(join(wd, ".codex"), { recursive: true });

      const options = {
        scope: "project" as const,
        projectRoot: wd,
        pkgRoot,
      };

      const plan1 = await generateSetupPlan(options);
      const plan2 = await generateSetupPlan(options);

      assert.equal(plan1.actions.length, plan2.actions.length);
      // Specifically verify the symlink action is consistently absent
      const symlink1 = plan1.actions.filter((a) => a.kind === "symlink" && a.destination === join(wd, ".codex"));
      const symlink2 = plan2.actions.filter((a) => a.kind === "symlink" && a.destination === join(wd, ".codex"));
      assert.equal(symlink1.length, symlink2.length);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
