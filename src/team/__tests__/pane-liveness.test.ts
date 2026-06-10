import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProcessProbeError,
  probeProcessLiveness,
  mergeLivenessSignals,
  type PaneLivenessState,
} from '../pane-liveness.js';

describe('pane-liveness', () => {
  describe('classifyProcessProbeError', () => {
    it('classifies ESRCH as dead', () => {
      const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      assert.equal(classifyProcessProbeError(err), 'dead');
    });

    it('classifies EPERM as unknown', () => {
      const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
      assert.equal(classifyProcessProbeError(err), 'unknown');
    });

    it('classifies EINVAL as dead', () => {
      const err = Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      assert.equal(classifyProcessProbeError(err), 'dead');
    });

    it('classifies unknown error as unknown', () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      assert.equal(classifyProcessProbeError(err), 'unknown');
    });
  });

  describe('probeProcessLiveness', () => {
    it('returns dead for pid 0', () => {
      assert.equal(probeProcessLiveness(0), 'dead');
    });

    it('returns dead for negative pid', () => {
      assert.equal(probeProcessLiveness(-1), 'dead');
    });

    it('returns alive for current process', () => {
      assert.equal(probeProcessLiveness(process.pid), 'alive');
    });

    it('returns dead for very large non-existent pid', () => {
      // PIDs are typically < 4M on Linux
      assert.equal(probeProcessLiveness(99999999), 'dead');
    });
  });

  describe('mergeLivenessSignals', () => {
    it('returns dead if any signal is dead', () => {
      assert.equal(mergeLivenessSignals(['alive', 'dead']), 'dead');
      assert.equal(mergeLivenessSignals(['unknown', 'dead']), 'dead');
    });

    it('returns alive if all signals are alive', () => {
      assert.equal(mergeLivenessSignals(['alive', 'alive']), 'alive');
    });

    it('returns unknown for empty signals', () => {
      assert.equal(mergeLivenessSignals([]), 'unknown');
    });

    it('returns unknown for mixed signals', () => {
      assert.equal(mergeLivenessSignals(['alive', 'unknown']), 'unknown');
    });

    it('returns stale when stale but no dead', () => {
      assert.equal(mergeLivenessSignals(['alive', 'stale']), 'stale');
    });

    it('dead takes priority over stale', () => {
      assert.equal(mergeLivenessSignals(['dead', 'stale']), 'dead');
    });
  });
});
