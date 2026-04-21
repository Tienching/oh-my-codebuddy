import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { buildStateContext, type StateContext } from '../context.js';

describe('buildStateContext', () => {
  it('builds a context with defaults', () => {
    const ctx = buildStateContext('/tmp/test-project');
    assert.equal(ctx.cwd, '/tmp/test-project');
    assert.equal(ctx.scope, 'project');
    assert.equal(ctx.readPolicy, 'canonical_first');
    assert.equal(ctx.writePolicy, 'canonical_only');
    assert.equal(ctx.sessionId, undefined);
  });

  it('accepts an explicit session ID', () => {
    const ctx = buildStateContext('/tmp/test-project', 'sess-123');
    assert.equal(ctx.sessionId, 'sess-123');
  });

  it('validates and rejects invalid session IDs', () => {
    assert.throws(() => buildStateContext('/tmp/test-project', '../invalid'));
  });

  it('allows overriding scope', () => {
    const ctx = buildStateContext('/tmp/test-project', undefined, { scope: 'user' });
    assert.equal(ctx.scope, 'user');
  });

  it('allows overriding read policy', () => {
    const ctx = buildStateContext('/tmp/test-project', undefined, { readPolicy: 'legacy_first' });
    assert.equal(ctx.readPolicy, 'legacy_first');
  });

  it('allows overriding write policy', () => {
    const ctx = buildStateContext('/tmp/test-project', undefined, { writePolicy: 'dual_write_compat' });
    assert.equal(ctx.writePolicy, 'dual_write_compat');
  });

  it('allows setting runtime hints', () => {
    const ctx = buildStateContext('/tmp/test-project', undefined, {
      runtimeHints: { mode: 'ralph', isRalphActive: true },
    });
    assert.equal(ctx.runtimeHints?.mode, 'ralph');
    assert.equal(ctx.runtimeHints?.isRalphActive, true);
    assert.equal(ctx.runtimeHints?.isTeamActive, undefined);
  });

  it('uses process.cwd() when no working directory is provided', () => {
    const ctx = buildStateContext();
    assert.equal(ctx.cwd, process.cwd());
  });

  it('preserves options that are not overridden', () => {
    const ctx = buildStateContext('/tmp/test-project', undefined, { scope: 'user' });
    assert.equal(ctx.readPolicy, 'canonical_first');
    assert.equal(ctx.writePolicy, 'canonical_only');
  });
});
