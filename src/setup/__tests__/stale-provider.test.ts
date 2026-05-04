import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectStaleProjectProviderResidue,
  formatStaleProviderResidueHint,
  providerDirNameToFlag,
  type ProviderDirName,
} from "../stale-provider.js";

/**
 * Regression coverage for architect-review M3 (2026-04-30) / QA Matrix E.
 *
 * Switching `--provider` at project scope without running `omb uninstall` on
 * the previous provider leaves a stale `.codebuddy/` / `.codex/` / `.claude/`
 * directory that setup overwrites at the new provider's path but doctor
 * never flags. These tests pin the detection contract used by both
 * `src/cli/setup.ts` (setup-time warning) and `src/cli/doctor.ts`
 * (doctor-time warning).
 */
describe("detectStaleProjectProviderResidue", () => {
  async function seedDir(
    root: string,
    providerDir: ProviderDirName,
    markers: readonly string[],
  ): Promise<void> {
    const base = join(root, providerDir);
    await mkdir(base, { recursive: true });
    for (const marker of markers) {
      const full = join(base, marker);
      // All OMB markers are files except `prompts` / `skills` / `agents`
      // which are directories. Honour the marker semantics.
      if (
        marker === "prompts" ||
        marker === "skills" ||
        marker === "agents"
      ) {
        await mkdir(full, { recursive: true });
      } else {
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, "seed");
      }
    }
  }

  it("returns empty when no provider dirs exist", async () => {
    const wd = await mkdtemp(join(tmpdir(), "stale-empty-"));
    try {
      assert.deepEqual(detectStaleProjectProviderResidue(wd, [".claude"]), []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("ignores the active provider even when populated", async () => {
    const wd = await mkdtemp(join(tmpdir(), "stale-active-"));
    try {
      await seedDir(wd, ".claude", ["hooks/hooks.json", ".omb-config.json"]);
      assert.deepEqual(detectStaleProjectProviderResidue(wd, [".claude"]), []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("flags a stale codebuddy dir when active provider is claude", async () => {
    const wd = await mkdtemp(join(tmpdir(), "stale-switch-cb-claude-"));
    try {
      await seedDir(wd, ".codebuddy", ["hooks.json", "prompts", "skills"]);
      await seedDir(wd, ".claude", ["hooks/hooks.json"]);
      const residues = detectStaleProjectProviderResidue(wd, [".claude"]);
      assert.equal(residues.length, 1);
      assert.equal(residues[0]!.providerDirName, ".codebuddy");
      assert.equal(residues[0]!.absPath, join(wd, ".codebuddy"));
      assert.deepEqual(residues[0]!.matchedMarkers.sort(), [
        "hooks.json",
        "prompts",
        "skills",
      ]);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("flags a stale claude dir at its subdirectory hooks path, not the flat one", async () => {
    const wd = await mkdtemp(join(tmpdir(), "stale-claude-subdir-"));
    try {
      // Claude residue must be detected via `hooks/hooks.json` (subdir), NOT
      // `hooks.json` flat, because the subdir path is what Claude CLI reads.
      await seedDir(wd, ".claude", ["hooks/hooks.json"]);
      await seedDir(wd, ".codebuddy", ["hooks.json"]);
      const residues = detectStaleProjectProviderResidue(wd, [".codebuddy"]);
      assert.equal(residues.length, 1);
      assert.equal(residues[0]!.providerDirName, ".claude");
      assert.deepEqual(residues[0]!.matchedMarkers, ["hooks/hooks.json"]);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does NOT flag empty provider dirs (no OMB marker = not our residue)", async () => {
    const wd = await mkdtemp(join(tmpdir(), "stale-empty-dir-"));
    try {
      await mkdir(join(wd, ".codebuddy"), { recursive: true });
      await seedDir(wd, ".claude", ["hooks/hooks.json"]);
      assert.deepEqual(detectStaleProjectProviderResidue(wd, [".claude"]), []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does NOT flag a naked user-owned ~/.claude/settings.json alone", async () => {
    // A user may drop their own settings.json into .claude/ before ever
    // running OMB. Shared-ownership: OMB must not claim files it did not
    // author as its own residue.
    const wd = await mkdtemp(join(tmpdir(), "stale-user-settings-"));
    try {
      await mkdir(join(wd, ".claude"), { recursive: true });
      await writeFile(join(wd, ".claude", "settings.json"), "{}");
      await seedDir(wd, ".codebuddy", ["hooks.json"]);
      assert.deepEqual(
        detectStaleProjectProviderResidue(wd, [".codebuddy"]),
        [],
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("handles --provider both active (codebuddy + codex), flags only claude", async () => {
    const wd = await mkdtemp(join(tmpdir(), "stale-both-"));
    try {
      await seedDir(wd, ".codebuddy", ["hooks.json"]);
      await seedDir(wd, ".codex", ["hooks.json"]);
      await seedDir(wd, ".claude", [".omb-config.json"]);
      const residues = detectStaleProjectProviderResidue(wd, [
        ".codebuddy",
        ".codex",
      ]);
      assert.equal(residues.length, 1);
      assert.equal(residues[0]!.providerDirName, ".claude");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("handles --provider all active (all three), returns empty", async () => {
    const wd = await mkdtemp(join(tmpdir(), "stale-all-"));
    try {
      await seedDir(wd, ".codebuddy", ["hooks.json"]);
      await seedDir(wd, ".codex", ["hooks.json"]);
      await seedDir(wd, ".claude", ["hooks/hooks.json"]);
      assert.deepEqual(
        detectStaleProjectProviderResidue(wd, [
          ".codebuddy",
          ".codex",
          ".claude",
        ]),
        [],
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("producers a hint that names each residue and the uninstall command", () => {
    const hint = formatStaleProviderResidueHint([
      {
        providerDirName: ".codebuddy",
        absPath: "/tmp/wd/.codebuddy",
        matchedMarkers: ["hooks.json", ".omb-config.json"],
      },
      {
        providerDirName: ".codex",
        absPath: "/tmp/wd/.codex",
        matchedMarkers: ["hooks.json"],
      },
    ]);
    assert.ok(hint);
    assert.match(hint!, /\.codebuddy\//);
    assert.match(hint!, /\.codex\//);
    assert.match(
      hint!,
      /omb uninstall --provider codebuddy --scope project/,
    );
    assert.match(
      hint!,
      /omb uninstall --provider codex --scope project/,
    );
  });

  it("returns null hint when no residue", () => {
    assert.equal(formatStaleProviderResidueHint([]), null);
  });

  it("providerDirNameToFlag round-trips the three providers", () => {
    assert.equal(providerDirNameToFlag(".codebuddy"), "codebuddy");
    assert.equal(providerDirNameToFlag(".codex"), "codex");
    assert.equal(providerDirNameToFlag(".claude"), "claude");
  });
});
