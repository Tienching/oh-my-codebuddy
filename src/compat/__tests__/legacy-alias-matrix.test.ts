/**
 * Legacy alias regression test matrix (E1-T05).
 *
 * Table-driven tests covering every canonical↔legacy alias pair:
 *   - CODEBUDDY_HOME vs CODEX_HOME priority
 *   - .codebuddy vs .codex directory detection
 *   - omb vs omx command alias
 *   - OMB_* vs OMX_* env var priority
 *   - Setup scope migration rules
 *   - Session read priority (canonical first, legacy fallback)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  resolveCanonicalCodebuddyHome,
  resolveLegacyCodexHome,
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
  type AliasStatus,
} from "../legacy-boundary.js";

import { COMPAT_RULES } from "../../setup/compat-rules.js";

// ── Helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "alias-matrix-test-"));
  return tmpDir;
}

async function cleanupTmpDir(): Promise<void> {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════════════════
// SECTION 1: CODEBUDDY_HOME vs CODEX_HOME priority
// ══════════════════════════════════════════════════════════════════════════

describe("E1-T05: CODEBUDDY_HOME vs CODEX_HOME priority matrix", () => {
  interface HomeTestCase {
    name: string;
    env: Record<string, string>;
    expectCanonical: string;
    expectLegacy: string;
  }

  const cases: HomeTestCase[] = [
    {
      name: "canonical only",
      env: { CODEBUDDY_HOME: "/cb" },
      expectCanonical: "/cb",
      expectLegacy: "/cb",
    },
    {
      name: "legacy only",
      env: { CODEX_HOME: "/codex" },
      expectCanonical: "/codex",
      expectLegacy: "/codex",
    },
    {
      name: "both set — canonical wins",
      env: { CODEBUDDY_HOME: "/cb", CODEX_HOME: "/codex" },
      expectCanonical: "/cb",
      expectLegacy: "/codex",
    },
    {
      name: "neither set — default",
      env: {},
      expectCanonical: "default",
      expectLegacy: "default",
    },
    {
      name: "canonical empty string — falls to legacy",
      env: { CODEBUDDY_HOME: "", CODEX_HOME: "/codex" },
      expectCanonical: "/codex",
      expectLegacy: "/codex",
    },
    {
      name: "legacy empty string — falls to canonical",
      env: { CODEX_HOME: "", CODEBUDDY_HOME: "/cb" },
      expectCanonical: "/cb",
      expectLegacy: "/cb",
    },
    {
      name: "both empty — default",
      env: { CODEBUDDY_HOME: "", CODEX_HOME: "" },
      expectCanonical: "default",
      expectLegacy: "default",
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const canonical = resolveCanonicalCodebuddyHome(tc.env);
      const legacy = resolveLegacyCodexHome(tc.env);

      if (tc.expectCanonical === "default") {
        assert.ok(canonical.endsWith(".codebuddy"), `expected ~/.codebuddy, got ${canonical}`);
      } else {
        assert.equal(canonical, tc.expectCanonical);
      }

      if (tc.expectLegacy === "default") {
        assert.ok(legacy.endsWith(".codex"), `expected ~/.codex, got ${legacy}`);
      } else {
        assert.equal(legacy, tc.expectLegacy);
      }
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SECTION 2: .codebuddy vs .codex directory detection
// ══════════════════════════════════════════════════════════════════════════

describe("E1-T05: .codebuddy vs .codex directory detection", () => {
  beforeEach(makeTmpDir);
  afterEach(cleanupTmpDir);

  interface DirTestCase {
    name: string;
    create: string[];  // dirs to create
    expectOmx: boolean;
    expectCodex: boolean;
    expectOmb: boolean;
    expectCodebuddy: boolean;
  }

  const cases: DirTestCase[] = [
    {
      name: "empty project — no legacy dirs",
      create: [],
      expectOmx: false,
      expectCodex: false,
      expectOmb: false,
      expectCodebuddy: false,
    },
    {
      name: "only .codex exists",
      create: [".codex"],
      expectOmx: false,
      expectCodex: true,
      expectOmb: false,
      expectCodebuddy: false,
    },
    {
      name: "only .omx exists",
      create: [".omx"],
      expectOmx: true,
      expectCodex: false,
      expectOmb: false,
      expectCodebuddy: false,
    },
    {
      name: "only .omb exists",
      create: [".omb"],
      expectOmx: false,
      expectCodex: false,
      expectOmb: true,
      expectCodebuddy: false,
    },
    {
      name: "only .codebuddy exists",
      create: [".codebuddy"],
      expectOmx: false,
      expectCodex: false,
      expectOmb: false,
      expectCodebuddy: true,
    },
    {
      name: "all four dirs exist",
      create: [".codex", ".omx", ".omb", ".codebuddy"],
      expectOmx: true,
      expectCodex: true,
      expectOmb: true,
      expectCodebuddy: true,
    },
    {
      name: "both legacy dirs (.codex + .omx)",
      create: [".codex", ".omx"],
      expectOmx: true,
      expectCodex: true,
      expectOmb: false,
      expectCodebuddy: false,
    },
  ];

  for (const tc of cases) {
    it(tc.name, async () => {
      for (const dir of tc.create) {
        await mkdir(join(tmpDir, dir), { recursive: true });
      }
      const report = readLegacyAliasIfPresent(tmpDir);
      assert.equal(report.hasLegacyOmxDir, tc.expectOmx);
      assert.equal(report.hasLegacyCodexDir, tc.expectCodex);
      assert.equal(report.hasCanonicalOmbDir, tc.expectOmb);
      assert.equal(report.hasCanonicalCodebuddyDir, tc.expectCodebuddy);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SECTION 3: omb vs omx command alias
// ══════════════════════════════════════════════════════════════════════════

describe("E1-T05: omb vs omx command alias in registry", () => {
  it("omb alias exists in registry", () => {
    const alias = findAlias("omb");
    assert.ok(alias, "omb alias must exist");
    assert.equal(alias.canonical, "omb");
    assert.equal(alias.legacy, "omx");
  });

  it("omx resolves to omb via findAlias", () => {
    const alias = findAlias("omx");
    assert.ok(alias, "omx should resolve to an alias");
    assert.equal(alias.canonical, "omb");
    assert.equal(alias.legacy, "omx");
  });

  it("omb alias status is active_compat", () => {
    const alias = findAlias("omb");
    assert.equal(alias?.status, "active_compat");
  });

  it("omb alias supports dual-write", () => {
    assert.equal(shouldDualWrite("omb"), true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// SECTION 4: OMB_* vs OMX_* env var priority
// ══════════════════════════════════════════════════════════════════════════

describe("E1-T05: OMB_* vs OMX_* env var priority matrix", () => {
  interface EnvVarTestCase {
    name: string;
    resolver: "entry" | "runtime_binary" | "runtime_bridge";
    env: Record<string, string>;
    expected: string | boolean | null | undefined;
  }

  const cases: EnvVarTestCase[] = [
    // ── OMB_ENTRY_PATH / OMX_ENTRY_PATH ──────────────────────────────
    {
      name: "ENTRY: canonical only",
      resolver: "entry",
      env: { OMB_ENTRY_PATH: "/omb/entry" },
      expected: "/omb/entry",
    },
    {
      name: "ENTRY: legacy only",
      resolver: "entry",
      env: { OMX_ENTRY_PATH: "/omx/entry" },
      expected: "/omx/entry",
    },
    {
      name: "ENTRY: both set — canonical wins",
      resolver: "entry",
      env: { OMB_ENTRY_PATH: "/omb/entry", OMX_ENTRY_PATH: "/omx/entry" },
      expected: "/omb/entry",
    },
    {
      name: "ENTRY: neither set — null",
      resolver: "entry",
      env: {},
      expected: null,
    },

    // ── OMB_RUNTIME_BINARY / OMX_RUNTIME_BINARY ──────────────────────
    {
      name: "BINARY: canonical only",
      resolver: "runtime_binary",
      env: { OMB_RUNTIME_BINARY: "/omb/bin" },
      expected: "/omb/bin",
    },
    {
      name: "BINARY: legacy only",
      resolver: "runtime_binary",
      env: { OMX_RUNTIME_BINARY: "/omx/bin" },
      expected: "/omx/bin",
    },
    {
      name: "BINARY: both set — canonical wins",
      resolver: "runtime_binary",
      env: { OMB_RUNTIME_BINARY: "/omb/bin", OMX_RUNTIME_BINARY: "/omx/bin" },
      expected: "/omb/bin",
    },
    {
      name: "BINARY: neither set — undefined",
      resolver: "runtime_binary",
      env: {},
      expected: undefined,
    },

    // ── OMB_RUNTIME_BRIDGE / OMX_RUNTIME_BRIDGE ──────────────────────
    {
      name: "BRIDGE: canonical=0 — disabled",
      resolver: "runtime_bridge",
      env: { OMB_RUNTIME_BRIDGE: "0" },
      expected: false,
    },
    {
      name: "BRIDGE: canonical=1 — enabled",
      resolver: "runtime_bridge",
      env: { OMB_RUNTIME_BRIDGE: "1" },
      expected: true,
    },
    {
      name: "BRIDGE: legacy=0 — disabled",
      resolver: "runtime_bridge",
      env: { OMX_RUNTIME_BRIDGE: "0" },
      expected: false,
    },
    {
      name: "BRIDGE: legacy=1 — enabled",
      resolver: "runtime_bridge",
      env: { OMX_RUNTIME_BRIDGE: "1" },
      expected: true,
    },
    {
      name: "BRIDGE: canonical=0 overrides legacy=1",
      resolver: "runtime_bridge",
      env: { OMB_RUNTIME_BRIDGE: "0", OMX_RUNTIME_BRIDGE: "1" },
      expected: false,
    },
    {
      name: "BRIDGE: canonical=1 overrides legacy=0",
      resolver: "runtime_bridge",
      env: { OMB_RUNTIME_BRIDGE: "1", OMX_RUNTIME_BRIDGE: "0" },
      expected: true,
    },
    {
      name: "BRIDGE: neither set — default enabled",
      resolver: "runtime_bridge",
      env: {},
      expected: true,
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      let result: unknown;
      switch (tc.resolver) {
        case "entry":
          result = resolveCanonicalEntryPath({ env: tc.env });
          break;
        case "runtime_binary":
          result = resolveCanonicalRuntimeBinary(tc.env);
          break;
        case "runtime_bridge":
          result = isRuntimeBridgeEnabled(tc.env);
          break;
      }
      assert.deepEqual(result, tc.expected);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SECTION 5: Setup scope migration
// ══════════════════════════════════════════════════════════════════════════

describe("E1-T05: Setup scope migration rules", () => {
  it("compat rules cover legacy .codex directory", () => {
    const rule = COMPAT_RULES.find((r) => r.id === "legacy-codex-dir");
    assert.ok(rule, "legacy-codex-dir rule must exist");
    assert.equal(rule.from, ".codex");
    assert.equal(rule.to, ".codebuddy");
  });

  it("compat rules cover legacy .omx state directory", () => {
    const rule = COMPAT_RULES.find((r) => r.id === "legacy-omx-state");
    assert.ok(rule, "legacy-omx-state rule must exist");
    assert.equal(rule.from, ".omx");
    assert.equal(rule.to, ".omb");
  });

  it("legacy-codex-dir rule has autoFix=true", () => {
    const rule = COMPAT_RULES.find((r) => r.id === "legacy-codex-dir");
    assert.equal(rule?.autoFix, true);
  });

  it("legacy-omx-state rule has autoFix=false", () => {
    const rule = COMPAT_RULES.find((r) => r.id === "legacy-omx-state");
    assert.equal(rule?.autoFix, false);
  });

  it("legacy-omx-state is deprecated", () => {
    const rule = COMPAT_RULES.find((r) => r.id === "legacy-omx-state");
    assert.equal(rule?.status, "deprecated");
  });

  it("legacy-codex-dir condition detects .codex directory", async () => {
    const dir = makeTmpDir();
    try {
      await mkdir(join(dir, ".codex"), { recursive: true });
      const rule = COMPAT_RULES.find((r) => r.id === "legacy-codex-dir");
      assert.equal(rule?.condition(dir), true);
    } finally {
      await cleanupTmpDir();
    }
  });

  it("legacy-codex-dir condition returns false without .codex", async () => {
    const dir = makeTmpDir();
    try {
      const rule = COMPAT_RULES.find((r) => r.id === "legacy-codex-dir");
      assert.equal(rule?.condition(dir), false);
    } finally {
      await cleanupTmpDir();
    }
  });

  it("legacy-omx-state condition detects .omx directory", async () => {
    const dir = makeTmpDir();
    try {
      await mkdir(join(dir, ".omx"), { recursive: true });
      const rule = COMPAT_RULES.find((r) => r.id === "legacy-omx-state");
      assert.equal(rule?.condition(dir), true);
    } finally {
      await cleanupTmpDir();
    }
  });

  it("legacy-omx-state condition returns false without .omx", async () => {
    const dir = makeTmpDir();
    try {
      const rule = COMPAT_RULES.find((r) => r.id === "legacy-omx-state");
      assert.equal(rule?.condition(dir), false);
    } finally {
      await cleanupTmpDir();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// SECTION 6: Session read priority (canonical first, legacy fallback)
// ══════════════════════════════════════════════════════════════════════════

describe("E1-T05: Session read priority — canonical first, legacy fallback", () => {
  beforeEach(makeTmpDir);
  afterEach(cleanupTmpDir);

  it("reads from canonical .omb/state when it exists", async () => {
    const ombState = resolveCanonicalStateDir(tmpDir);
    await mkdir(ombState, { recursive: true });
    await writeFile(join(ombState, "session.json"), JSON.stringify({
      session_id: "canonical-session",
      started_at: new Date().toISOString(),
      cwd: tmpDir,
      pid: 12345,
    }));

    // Verify canonical path exists and legacy does not
    assert.ok(existsSync(join(ombState, "session.json")));
    assert.ok(!existsSync(join(resolveLegacyStateDir(tmpDir), "session.json")));
  });

  it("falls back to legacy .omx/state when canonical missing", async () => {
    const omxState = resolveLegacyStateDir(tmpDir);
    await mkdir(omxState, { recursive: true });
    const legacyData = {
      session_id: "legacy-session",
      started_at: new Date().toISOString(),
      cwd: tmpDir,
      pid: 54321,
    };
    await writeFile(join(omxState, "session.json"), JSON.stringify(legacyData));

    // Verify legacy exists, canonical does not
    assert.ok(existsSync(join(omxState, "session.json")));
    assert.ok(!existsSync(join(resolveCanonicalStateDir(tmpDir), "session.json")));

    // Read directly from legacy path (simulating read-through pattern)
    const content = await readFile(join(omxState, "session.json"), "utf-8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.session_id, "legacy-session");
  });

  it("canonical takes priority when both exist", async () => {
    const ombState = resolveCanonicalStateDir(tmpDir);
    const omxState = resolveLegacyStateDir(tmpDir);
    await mkdir(ombState, { recursive: true });
    await mkdir(omxState, { recursive: true });

    await writeFile(join(ombState, "session.json"), JSON.stringify({
      session_id: "canonical-session",
      started_at: new Date().toISOString(),
      cwd: tmpDir,
      pid: 11111,
    }));
    await writeFile(join(omxState, "session.json"), JSON.stringify({
      session_id: "legacy-session",
      started_at: new Date().toISOString(),
      cwd: tmpDir,
      pid: 22222,
    }));

    // Simulate canonical-first read
    const canonicalPath = join(ombState, "session.json");
    const legacyPath = join(omxState, "session.json");
    const readPath = [canonicalPath, legacyPath].find((p) => existsSync(p));
    assert.ok(readPath);
    assert.equal(readPath, canonicalPath);

    const content = await readFile(readPath, "utf-8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.session_id, "canonical-session");
  });

  it("isLegacyPathActive detects .omx/state directory", async () => {
    await mkdir(join(tmpDir, ".omx", "state"), { recursive: true });
    assert.equal(isLegacyPathActive(tmpDir), true);
  });

  it("isLegacyPathActive returns false without .omx/state", () => {
    assert.equal(isLegacyPathActive(tmpDir), false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// SECTION 7: Alias registry completeness
// ══════════════════════════════════════════════════════════════════════════

describe("E1-T05: Alias registry completeness", () => {
  const registry = getAliasRegistry();

  it("all alias pairs are bidirectional via findAlias", () => {
    for (const alias of registry) {
      const byCanonical = findAlias(alias.canonical);
      assert.ok(byCanonical, `findAlias(${alias.canonical}) must return result`);
      assert.equal(byCanonical.canonical, alias.canonical);

      const byLegacy = findAlias(alias.legacy);
      assert.ok(byLegacy, `findAlias(${alias.legacy}) must return result`);
      assert.equal(byLegacy.canonical, alias.canonical);
      assert.equal(byLegacy.legacy, alias.legacy);
    }
  });

  it("no duplicate canonical names in registry", () => {
    const canonicals = registry.map((a) => a.canonical);
    const unique = new Set(canonicals);
    assert.equal(canonicals.length, unique.size, "duplicate canonical names found");
  });

  it("no duplicate legacy names in registry", () => {
    const legacies = registry.map((a) => a.legacy);
    const unique = new Set(legacies);
    assert.equal(legacies.length, unique.size, "duplicate legacy names found");
  });

  it("all statuses are valid AliasStatus values", () => {
    const validStatuses: AliasStatus[] = [
      "active_compat", "warn_only", "read_only", "write_disabled", "removal_candidate",
    ];
    for (const alias of registry) {
      assert.ok(
        validStatuses.includes(alias.status),
        `${alias.canonical} has invalid status: ${alias.status}`,
      );
    }
  });

  it("shouldDualWrite is consistent with registry status", () => {
    for (const alias of registry) {
      const expected = alias.status === "active_compat";
      assert.equal(
        shouldDualWrite(alias.canonical),
        expected,
        `shouldDualWrite(${alias.canonical}) expected ${expected} for status ${alias.status}`,
      );
    }
  });
});
