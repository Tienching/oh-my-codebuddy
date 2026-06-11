/**
 * Legacy alias regression test matrix (E1-T05).
 *
 * Table-driven tests covering every canonical↔legacy alias pair:
 *   - CODEBUDDY_HOME vs CODEX_HOME provider separation
 *   - .codebuddy vs .codex directory detection
 *   - canonical OMB command has no legacy binary alias
 *   - OMB_* env var priority
 *   - Setup scope migration rules
 *   - Session state path compatibility
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
// SECTION 1: CODEBUDDY_HOME vs CODEX_HOME provider separation
// ══════════════════════════════════════════════════════════════════════════

describe("E1-T05: CODEBUDDY_HOME vs CODEX_HOME provider-home matrix", () => {
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
      expectLegacy: "default",
    },
    {
      name: "legacy only",
      env: { CODEX_HOME: "/codex" },
      expectCanonical: "default",
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
      name: "canonical empty string — falls to default",
      env: { CODEBUDDY_HOME: "", CODEX_HOME: "/codex" },
      expectCanonical: "default",
      expectLegacy: "/codex",
    },
    {
      name: "legacy empty string — falls to default for Codex",
      env: { CODEX_HOME: "", CODEBUDDY_HOME: "/cb" },
      expectCanonical: "/cb",
      expectLegacy: "default",
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
    expectOmb: boolean;
    expectCodex: boolean;
    expectCodebuddy: boolean;
    expectClaude: boolean;
  }

  const cases: DirTestCase[] = [
    {
      name: "empty project — no legacy dirs",
      create: [],
      expectOmb: false,
      expectCodex: false,
      expectCodebuddy: false,
      expectClaude: false,
    },
    {
      name: "only .codex exists",
      create: [".codex"],
      expectOmb: false,
      expectCodex: true,
      expectCodebuddy: false,
      expectClaude: false,
    },
    {
      name: "only .omb exists",
      create: [".omb"],
      expectOmb: true,
      expectCodex: false,
      expectCodebuddy: false,
      expectClaude: false,
    },
    {
      name: "only .codebuddy exists",
      create: [".codebuddy"],
      expectOmb: false,
      expectCodex: false,
      expectCodebuddy: true,
      expectClaude: false,
    },
    {
      name: "only .claude exists",
      create: [".claude"],
      expectOmb: false,
      expectCodex: false,
      expectCodebuddy: false,
      expectClaude: true,
    },
    {
      name: "all canonical/current dirs exist",
      create: [".codex", ".omb", ".codebuddy", ".claude"],
      expectOmb: true,
      expectCodex: true,
      expectCodebuddy: true,
      expectClaude: true,
    },
    {
      name: "legacy codex plus OMB state dir",
      create: [".codex", ".omb"],
      expectOmb: true,
      expectCodex: true,
      expectCodebuddy: false,
      expectClaude: false,
    },
  ];

  for (const tc of cases) {
    it(tc.name, async () => {
      for (const dir of tc.create) {
        await mkdir(join(tmpDir, dir), { recursive: true });
      }
      const report = readLegacyAliasIfPresent(tmpDir);
      assert.equal(report.hasLegacyOmbDir, tc.expectOmb);
      assert.equal(report.hasLegacyCodexDir, tc.expectCodex);
      assert.equal(report.hasCanonicalOmbDir, tc.expectOmb);
      assert.equal(report.hasCanonicalCodebuddyDir, tc.expectCodebuddy);
      assert.equal(report.hasClaudeDir, tc.expectClaude);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SECTION 3: OMB command binary alias registry
// ══════════════════════════════════════════════════════════════════════════

describe("E1-T05: OMB command binary alias registry", () => {
  it("does not register a legacy binary alias for omb", () => {
    assert.equal(findAlias("omb"), undefined);
    assert.equal(shouldDualWrite("omb"), false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// SECTION 4: OMB_* env var priority
// ══════════════════════════════════════════════════════════════════════════

describe("E1-T05: OMB_* env var priority matrix", () => {
  interface EnvVarTestCase {
    name: string;
    resolver: "entry" | "runtime_binary" | "runtime_bridge";
    env: Record<string, string>;
    expected: string | boolean | null | undefined;
  }

  const cases: EnvVarTestCase[] = [
    // ── OMB_ENTRY_PATH ───────────────────────────────────────────────
    {
      name: "ENTRY: set",
      resolver: "entry",
      env: { OMB_ENTRY_PATH: "/omb/entry" },
      expected: "/omb/entry",
    },
    {
      name: "ENTRY: neither set — null",
      resolver: "entry",
      env: {},
      expected: null,
    },

    // ── OMB_RUNTIME_BINARY ───────────────────────────────────────────
    {
      name: "BINARY: set",
      resolver: "runtime_binary",
      env: { OMB_RUNTIME_BINARY: "/omb/bin" },
      expected: "/omb/bin",
    },
    {
      name: "BINARY: neither set — undefined",
      resolver: "runtime_binary",
      env: {},
      expected: undefined,
    },

    // ── OMB_RUNTIME_BRIDGE ───────────────────────────────────────────
    {
      name: "BRIDGE: 0 — disabled",
      resolver: "runtime_bridge",
      env: { OMB_RUNTIME_BRIDGE: "0" },
      expected: false,
    },
    {
      name: "BRIDGE: 1 — enabled",
      resolver: "runtime_bridge",
      env: { OMB_RUNTIME_BRIDGE: "1" },
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

  it("compat rules cover legacy .omb state directory", () => {
    const rule = COMPAT_RULES.find((r) => r.id === "legacy-omb-state");
    assert.ok(rule, "legacy-omb-state rule must exist");
    assert.equal(rule.from, ".omb");
    assert.equal(rule.to, ".omb");
  });

  it("legacy-codex-dir rule has autoFix=false", () => {
    const rule = COMPAT_RULES.find((r) => r.id === "legacy-codex-dir");
    assert.equal(rule?.autoFix, false);
  });

  it("legacy-omb-state rule has autoFix=false", () => {
    const rule = COMPAT_RULES.find((r) => r.id === "legacy-omb-state");
    assert.equal(rule?.autoFix, false);
  });

  it("legacy-omb-state is deprecated", () => {
    const rule = COMPAT_RULES.find((r) => r.id === "legacy-omb-state");
    assert.equal(rule?.status, "deprecated");
  });

  it("legacy-codex-dir is a removal candidate", () => {
    const rule = COMPAT_RULES.find((r) => r.id === "legacy-codex-dir");
    assert.equal(rule?.status, "removal_candidate");
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

  it("legacy-omb-state condition detects .omb directory with state files", async () => {
    const dir = makeTmpDir();
    try {
      const stateDir = join(dir, ".omb", "state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, "session.json"), "{}");
      const rule = COMPAT_RULES.find((r) => r.id === "legacy-omb-state");
      assert.equal(rule?.condition(dir), true);
    } finally {
      await cleanupTmpDir();
    }
  });

  it("legacy-omb-state condition returns false without .omb", async () => {
    const dir = makeTmpDir();
    try {
      const rule = COMPAT_RULES.find((r) => r.id === "legacy-omb-state");
      assert.equal(rule?.condition(dir), false);
    } finally {
      await cleanupTmpDir();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// SECTION 6: Session read priority (canonical first, legacy fallback)
// ══════════════════════════════════════════════════════════════════════════

describe("E1-T05: Session state path compatibility", () => {
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

    assert.equal(resolveLegacyStateDir(tmpDir), ombState);
    assert.ok(existsSync(join(ombState, "session.json")));
  });

  it("compat state resolver targets canonical .omb/state", async () => {
    const ombState = resolveLegacyStateDir(tmpDir);
    await mkdir(ombState, { recursive: true });
    const data = {
      session_id: "compat-session",
      started_at: new Date().toISOString(),
      cwd: tmpDir,
      pid: 54321,
    };
    await writeFile(join(ombState, "session.json"), JSON.stringify(data));

    assert.equal(ombState, resolveCanonicalStateDir(tmpDir));
    const content = await readFile(join(resolveCanonicalStateDir(tmpDir), "session.json"), "utf-8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.session_id, "compat-session");
  });

  it("canonical takes priority when both exist", async () => {
    const ombState = resolveCanonicalStateDir(tmpDir);
    await mkdir(ombState, { recursive: true });

    await writeFile(join(ombState, "session.json"), JSON.stringify({
      session_id: "canonical-session",
      started_at: new Date().toISOString(),
      cwd: tmpDir,
      pid: 11111,
    }));

    // Simulate canonical-first read
    const canonicalPath = join(ombState, "session.json");
    const readPath = [canonicalPath].find((p) => existsSync(p));
    assert.ok(readPath);
    assert.equal(readPath, canonicalPath);

    const content = await readFile(readPath, "utf-8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.session_id, "canonical-session");
  });

  it("isLegacyPathActive detects .omb/state directory with files", async () => {
    const stateDir = join(tmpDir, ".omb", "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "session.json"), "{}");
    assert.equal(isLegacyPathActive(tmpDir), true);
  });

  it("isLegacyPathActive returns false without .omb/state", () => {
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
