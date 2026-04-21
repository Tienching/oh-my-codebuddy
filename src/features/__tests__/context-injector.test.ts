import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isExperimentalContextInjectorEnabled,
  maybeCollectContextInjection,
} from '../context-injector/index.js';

describe('context injector seam', () => {
  it('stays disabled by default', () => {
    assert.equal(isExperimentalContextInjectorEnabled({}), false);
  });

  it('collects repository context only when explicitly enabled', async () => {
    const result = await maybeCollectContextInjection('/repo', {
      env: {
        OMB_PROVIDER_CONTEXT_INJECTION: '1',
      },
      gitRunner: (_cwd, args) => {
        if (args.join(' ') === 'remote') return 'origin\nupstream';
        if (args.join(' ') === 'remote get-url origin') {
          return 'https://github.com/acme/origin.git';
        }
        if (args.join(' ') === 'remote get-url upstream') {
          return 'https://gitlab.com/acme/upstream.git';
        }
        return null;
      },
    });

    assert.equal(result.enabled, true);
    assert.equal(result.snapshot?.primary?.provider, 'github');
    assert.equal(result.snapshot?.remotes.length, 2);
    assert.match(result.text ?? '', /Repository provider: github:acme\/origin/);
  });

  it('returns an inert result when the feature flag is disabled', async () => {
    const result = await maybeCollectContextInjection('/repo', {
      gitRunner: () => {
        throw new Error('git should not run when feature is disabled');
      },
    });

    assert.deepEqual(result, {
      enabled: false,
      snapshot: null,
      text: null,
    });
  });
});
