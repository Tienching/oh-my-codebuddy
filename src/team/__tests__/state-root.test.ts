import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCanonicalTeamStateRoot } from '../state-root.js';

describe('state-root', () => {
  it('resolveCanonicalTeamStateRoot resolves to leader .omb/state', () => {
    assert.equal(
      resolveCanonicalTeamStateRoot('/tmp/demo/project', {}),
      '/tmp/demo/project/.omb/state',
    );
  });

  it('prefers OMB_TEAM_STATE_ROOT when present', () => {
    assert.equal(
      resolveCanonicalTeamStateRoot('/tmp/demo/project', {
        OMB_TEAM_STATE_ROOT: '/tmp/shared/team-state',
      }),
      '/tmp/shared/team-state',
    );
  });

  it('falls back to OMX_TEAM_STATE_ROOT when present', () => {
    assert.equal(
      resolveCanonicalTeamStateRoot('/tmp/demo/project', {
        OMX_TEAM_STATE_ROOT: '/tmp/shared/team-state',
      }),
      '/tmp/shared/team-state',
    );
  });

  it('resolves relative OMX_TEAM_STATE_ROOT from the leader cwd', () => {
    assert.equal(
      resolveCanonicalTeamStateRoot('/tmp/demo/project', {
        OMX_TEAM_STATE_ROOT: '../shared/state',
      }),
      '/tmp/demo/shared/state',
    );
  });
});
