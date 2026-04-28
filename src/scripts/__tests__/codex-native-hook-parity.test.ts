/**
 * Regression guard: the Codex native-hook entry script must remain a thin
 * wrapper that re-exports the CodeBuddy native-hook implementation. This
 * guarantees both providers dispatch the same lifecycle handlers while the
 * install surface (config/codebuddy-hooks.ts) still chooses provider-specific
 * script names (`codebuddy-native-hook.js` vs `codex-native-hook.js`).
 *
 * If this drifts, Codex-provider installs silently skip new CodeBuddy hook
 * behaviour (or vice versa), which was the class of bug behind the
 * docs/codex-native-hooks.md update in handoff §8.3.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapCodexHookEventToOmbEvent,
  dispatchCodexNativeHook,
  runCodexNativeHookCli,
} from '../codebuddy-native-hook.js';
import * as codebuddyHookModule from '../codebuddy-native-hook.js';
import * as codexHookModule from '../codex-native-hook.js';
import {
  buildManagedCodebuddyHooksConfig,
  buildManagedCodexHooksConfig,
} from '../../config/codebuddy-hooks.js';

describe('native hook provider parity', () => {
  it('codex-native-hook re-exports the CodeBuddy native-hook implementation', () => {
    // All named exports on the CodeBuddy entry must be visible on the Codex
    // entry — otherwise Codex-provider installs silently lose hook
    // dispatch handlers that the CodeBuddy entry gained.
    for (const name of Object.keys(codebuddyHookModule)) {
      assert.ok(
        name in codexHookModule,
        `codex-native-hook missing re-exported symbol: ${name}`,
      );
    }
  });

  it('critical dispatch functions are accessible through the CodeBuddy entry', () => {
    // Guard the symbols install plus runtime actually call into, so refactors
    // that quietly rename them surface here instead of at install time.
    assert.equal(typeof mapCodexHookEventToOmbEvent, 'function');
    assert.equal(typeof dispatchCodexNativeHook, 'function');
    assert.equal(typeof runCodexNativeHookCli, 'function');
  });

  it('codex-native-hook forwards a SessionStart event through the same mapper', () => {
    // Belt-and-braces: check the reverse direction too so the Codex module
    // exposes the mapper it needs to call.
    const mapperFromCodex = (codexHookModule as unknown as {
      mapCodexHookEventToOmbEvent: typeof mapCodexHookEventToOmbEvent;
    }).mapCodexHookEventToOmbEvent;
    assert.equal(mapperFromCodex('SessionStart'), 'session-start');
    // Same mapper instance (re-export, not re-implementation).
    assert.strictEqual(mapperFromCodex, mapCodexHookEventToOmbEvent);
  });
});

describe('native hooks.json install surface splits provider script names', () => {
  it('CodeBuddy provider installs codebuddy-native-hook.js wrappers', () => {
    const pkgRoot = '/tmp/omb-pkg-root-for-parity';
    const config = buildManagedCodebuddyHooksConfig(pkgRoot);
    const serialized = JSON.stringify(config);
    assert.match(
      serialized,
      /codebuddy-native-hook\.js/,
      'CodeBuddy managed hooks must reference codebuddy-native-hook.js',
    );
    assert.doesNotMatch(
      serialized,
      /codex-native-hook\.js/,
      'CodeBuddy managed hooks must not point at the Codex script',
    );
  });

  it('Codex provider installs codex-native-hook.js wrappers', () => {
    const pkgRoot = '/tmp/omb-pkg-root-for-parity';
    const config = buildManagedCodexHooksConfig(pkgRoot);
    const serialized = JSON.stringify(config);
    assert.match(
      serialized,
      /codex-native-hook\.js/,
      'Codex managed hooks must reference codex-native-hook.js',
    );
    assert.doesNotMatch(
      serialized,
      /codebuddy-native-hook\.js/,
      'Codex managed hooks must not point at the CodeBuddy script',
    );
  });
});
