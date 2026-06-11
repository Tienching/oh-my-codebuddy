import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  resolveCanonicalCodebuddyHome,
  resolveLegacyCodexHome,
  resolveStateDir,
  resolveCanonicalStateDir,
  resolveLegacyStateDir,
  resolveCanonicalEntryPath,
  resolveCanonicalRuntimeBinary,
  isRuntimeBridgeEnabled,
  readLegacyAliasIfPresent,
  isLegacyPathActive,
  getAliasRegistry,
  findAlias,
  shouldDualWrite,
  type LegacyAlias,
} from "../legacy-boundary.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function envWith(pairs: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...pairs };
}

function envWithout(...keys: string[]): NodeJS.ProcessEnv {
  const e = { ...process.env };
  for (const k of keys) delete e[k];
  return e;
}

let tmpDir: string;

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "legacy-boundary-test-"));
  return tmpDir;
}

async function cleanupTmpDir(): Promise<void> {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── resolveCanonicalCodebuddyHome ────────────────────────────────────────

describe("resolveCanonicalCodebuddyHome", () => {
  it("returns CODEBUDDY_HOME when set", () => {
    const result = resolveCanonicalCodebuddyHome(
      envWith({ CODEBUDDY_HOME: "/custom/codebuddy" }),
    );
    assert.equal(result, "/custom/codebuddy");
  });

  it("ignores CODEX_HOME when CODEBUDDY_HOME is not set", () => {
    const result = resolveCanonicalCodebuddyHome(
      envWithout("CODEBUDDY_HOME").constructor === Object
        ? { ...envWithout("CODEBUDDY_HOME"), CODEX_HOME: "/custom/codex" }
        : envWith({ CODEX_HOME: "/custom/codex" }),
    );
    assert.ok(result.endsWith(".codebuddy"));
  });

  it("prefers CODEBUDDY_HOME over CODEX_HOME when both are set", () => {
    const result = resolveCanonicalCodebuddyHome(
      envWith({ CODEBUDDY_HOME: "/cb", CODEX_HOME: "/codex" }),
    );
    assert.equal(result, "/cb");
  });

  it("falls back to ~/.codebuddy when neither env var is set", () => {
    const e: NodeJS.ProcessEnv = {};
    const result = resolveCanonicalCodebuddyHome(e);
    assert.ok(result.endsWith(".codebuddy"));
  });
});

// ── resolveLegacyCodexHome ───────────────────────────────────────────────

describe("resolveLegacyCodexHome", () => {
  it("returns CODEX_HOME when set", () => {
    const result = resolveLegacyCodexHome(
      envWith({ CODEX_HOME: "/custom/codex" }),
    );
    assert.equal(result, "/custom/codex");
  });

  it("ignores CODEBUDDY_HOME when CODEX_HOME is not set", () => {
    const env = { ...envWithout("CODEX_HOME"), CODEBUDDY_HOME: "/cb" };
    const result = resolveLegacyCodexHome(env);
    assert.ok(result.endsWith(".codex"));
  });

  it("falls back to ~/.codex when neither is set", () => {
    const result = resolveLegacyCodexHome({});
    assert.ok(result.endsWith(".codex"));
  });
});

// ── resolveStateDir ─────────────────────────────────────────────────────

describe("resolveStateDir", () => {
  it("returns .omb/state under the given cwd", () => {
    const result = resolveStateDir("/project/root");
    assert.equal(result, "/project/root/.omb/state");
  });

  it("returns .omb/state under process.cwd() when no arg", () => {
    const result = resolveStateDir(process.cwd());
    assert.ok(result.endsWith(".omb/state"));
  });

  it("deprecated aliases resolveCanonicalStateDir and resolveLegacyStateDir resolve to the same path", () => {
    const cwd = "/project/root";
    assert.equal(resolveCanonicalStateDir(cwd), resolveStateDir(cwd));
    assert.equal(resolveLegacyStateDir(cwd), resolveStateDir(cwd));
  });
});

// ── resolveCanonicalEntryPath ────────────────────────────────────────────

describe("resolveCanonicalEntryPath", () => {
  it("returns OMB_ENTRY_PATH when set", () => {
    const result = resolveCanonicalEntryPath({
      env: envWith({ OMB_ENTRY_PATH: "/path/to/omb.js" }),
    });
    assert.equal(result, "/path/to/omb.js");
  });

  it("returns null when neither env var is set", () => {
    const result = resolveCanonicalEntryPath({ env: {} });
    assert.equal(result, null);
  });
});

// ── resolveCanonicalRuntimeBinary ────────────────────────────────────────

describe("resolveCanonicalRuntimeBinary", () => {
  it("returns OMB_RUNTIME_BINARY when set", () => {
    const result = resolveCanonicalRuntimeBinary(
      envWith({ OMB_RUNTIME_BINARY: "/bin/omb-runtime" }),
    );
    assert.equal(result, "/bin/omb-runtime");
  });

  it("returns undefined when neither is set", () => {
    const result = resolveCanonicalRuntimeBinary({});
    assert.equal(result, undefined);
  });
});

// ── isRuntimeBridgeEnabled ───────────────────────────────────────────────

describe("isRuntimeBridgeEnabled", () => {
  it("is disabled when OMB_RUNTIME_BRIDGE=0", () => {
    assert.equal(
      isRuntimeBridgeEnabled(envWith({ OMB_RUNTIME_BRIDGE: "0" })),
      false,
    );
  });

  it("is enabled when OMB_RUNTIME_BRIDGE=1", () => {
    assert.equal(
      isRuntimeBridgeEnabled(envWith({ OMB_RUNTIME_BRIDGE: "1" })),
      true,
    );
  });

  it("falls back to OMB_RUNTIME_BRIDGE=0", () => {
    const e = envWithout("OMB_RUNTIME_BRIDGE");
    e.OMB_RUNTIME_BRIDGE = "0";
    assert.equal(isRuntimeBridgeEnabled(e), false);
  });

  it("is enabled by default when neither env var is set", () => {
    assert.equal(isRuntimeBridgeEnabled({}), true);
  });
});

// ── getAliasRegistry ─────────────────────────────────────────────────────

describe("getAliasRegistry", () => {
  it("returns a non-empty array", () => {
    const registry = getAliasRegistry();
    assert.ok(Array.isArray(registry));
    assert.ok(registry.length > 0);
  });

  it("contains expected env var aliases", () => {
    const registry = getAliasRegistry();
    const canonicalNames = registry.map((a) => a.canonical);
    assert.ok(canonicalNames.includes("CODEBUDDY_HOME"));
  });

  it("contains expected directory aliases", () => {
    const registry = getAliasRegistry();
    const canonicalNames = registry.map((a) => a.canonical);
    assert.ok(canonicalNames.includes(".codebuddy"));
  });

  it("every entry has the required fields", () => {
    const registry = getAliasRegistry();
    for (const alias of registry) {
      assert.ok(typeof alias.canonical === "string" && alias.canonical.length > 0);
      assert.ok(typeof alias.legacy === "string" && alias.legacy.length > 0);
      assert.ok(
        ["active_compat", "warn_only", "read_only", "write_disabled", "removal_candidate"].includes(
          alias.status,
        ),
      );
      assert.ok(typeof alias.description === "string" && alias.description.length > 0);
    }
  });
});

// ── findAlias ────────────────────────────────────────────────────────────

describe("findAlias", () => {
  it("finds by canonical name", () => {
    const alias = findAlias("CODEBUDDY_HOME");
    assert.ok(alias);
    assert.equal(alias?.canonical, "CODEBUDDY_HOME");
    assert.equal(alias?.legacy, "CODEX_HOME");
  });

  it("finds by legacy name", () => {
    const alias = findAlias("CODEX_HOME");
    assert.ok(alias);
    assert.equal(alias?.canonical, "CODEBUDDY_HOME");
  });

  it("returns undefined for unknown name", () => {
    assert.equal(findAlias("NONEXISTENT"), undefined);
  });
});

// ── shouldDualWrite ──────────────────────────────────────────────────────

describe("shouldDualWrite", () => {
  it("returns false for the CODEX_HOME removal-candidate alias", () => {
    assert.equal(shouldDualWrite("CODEBUDDY_HOME"), false);
  });

  it("returns false for read_only alias", () => {
    // .codebuddy has status 'read_only'
    assert.equal(shouldDualWrite(".codebuddy"), false);
  });

  it("returns false for unknown alias", () => {
    assert.equal(shouldDualWrite("nonexistent"), false);
  });
});

// ── readLegacyAliasIfPresent ─────────────────────────────────────────────

describe("readLegacyAliasIfPresent", () => {
  beforeEach(() => { makeTmpDir(); });
  afterEach(cleanupTmpDir);

  it("detects .omb directory", async () => {
    await mkdir(join(tmpDir, ".omb"), { recursive: true });
    const report = readLegacyAliasIfPresent(tmpDir);
    assert.equal(report.hasLegacyOmbDir, true);
    assert.equal(report.hasLegacyCodexDir, false);
  });

  it("detects .codex directory", async () => {
    await mkdir(join(tmpDir, ".codex"), { recursive: true });
    const report = readLegacyAliasIfPresent(tmpDir);
    assert.equal(report.hasLegacyCodexDir, true);
    assert.equal(report.hasLegacyOmbDir, false);
  });

  it("detects .omb directory", async () => {
    await mkdir(join(tmpDir, ".omb"), { recursive: true });
    const report = readLegacyAliasIfPresent(tmpDir);
    assert.equal(report.hasCanonicalOmbDir, true);
  });

  it("detects .codebuddy directory", async () => {
    await mkdir(join(tmpDir, ".codebuddy"), { recursive: true });
    const report = readLegacyAliasIfPresent(tmpDir);
    assert.equal(report.hasCanonicalCodebuddyDir, true);
  });

  it("returns all false for empty directory", () => {
    const report = readLegacyAliasIfPresent(tmpDir);
    assert.equal(report.hasLegacyOmbDir, false);
    assert.equal(report.hasLegacyCodexDir, false);
    assert.equal(report.hasCanonicalOmbDir, false);
    assert.equal(report.hasCanonicalCodebuddyDir, false);
  });
});

// ── isLegacyPathActive ───────────────────────────────────────────────────

describe("isLegacyPathActive", () => {
  beforeEach(() => { makeTmpDir(); });
  afterEach(cleanupTmpDir);

  it("returns true when .omb/state exists and contains files", async () => {
    const stateDir = join(tmpDir, ".omb", "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "session.json"), "{}");
    assert.equal(isLegacyPathActive(tmpDir), true);
  });

  it("returns false when .omb/state does not exist", () => {
    assert.equal(isLegacyPathActive(tmpDir), false);
  });

  it("returns false when .omb/state exists but is empty", async () => {
    await mkdir(join(tmpDir, ".omb", "state"), { recursive: true });
    assert.equal(isLegacyPathActive(tmpDir), false);
  });
});

// ── Priority: canonical > default ────────────────────────────────────────

describe("priority: provider env var > default", () => {
  it("CODEBUDDY_HOME wins over default and ignores CODEX_HOME", () => {
    const env = envWith({
      CODEBUDDY_HOME: "/canonical",
      CODEX_HOME: "/legacy",
    });
    assert.equal(resolveCanonicalCodebuddyHome(env), "/canonical");
  });

  it("CODEX_HOME does not affect CodeBuddy home when CODEBUDDY_HOME is absent", () => {
    const env = { CODEX_HOME: "/legacy" };
    assert.ok(resolveCanonicalCodebuddyHome(env).endsWith(".codebuddy"));
  });

  it("OMB_ENTRY_PATH is used when set", () => {
    const env = { OMB_ENTRY_PATH: "/omb" };
    assert.equal(resolveCanonicalEntryPath({ env }), "/omb");
  });

  it("OMB_RUNTIME_BINARY is used when set", () => {
    const env = { OMB_RUNTIME_BINARY: "/omb-bin" };
    assert.equal(resolveCanonicalRuntimeBinary(env), "/omb-bin");
  });
});
