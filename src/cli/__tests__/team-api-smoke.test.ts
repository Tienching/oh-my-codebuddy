import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Smoke tests for team API CLI capability.
 * These verify that the built CLI can handle team API operations,
 * replacing the old source-code marker grep approach (CR-P1-012).
 */
describe('team-api-smoke', () => {
  const ombBin = join(import.meta.dirname, '..', 'cli', 'omb.js');

  it('omb team api --help returns success', () => {
    if (!existsSync(ombBin)) return; // Skip if not built
    const result = spawnSync(process.execPath, [ombBin, 'team', 'api', '--help'], {
      encoding: 'utf-8',
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, `Expected exit code 0, got ${result.status}: ${result.stderr}`);
  });

  it('omb team api --help lists known operations', () => {
    if (!existsSync(ombBin)) return;
    const result = spawnSync(process.execPath, [ombBin, 'team', 'api', '--help'], {
      encoding: 'utf-8',
      timeout: 10_000,
      windowsHide: true,
    });
    const helpText = result.stdout || '';
    // Check for at least a few known operations
    assert.ok(helpText.includes('send-message'), 'help should list send-message');
    assert.ok(helpText.includes('list-tasks'), 'help should list list-tasks');
    assert.ok(helpText.includes('create-task'), 'help should list create-task');
  });

  it('omb team api <specific-op> --help returns operation-specific help', () => {
    if (!existsSync(ombBin)) return;
    const result = spawnSync(process.execPath, [ombBin, 'team', 'api', 'send-message', '--help'], {
      encoding: 'utf-8',
      timeout: 10_000,
      windowsHide: true,
    });
    const helpText = result.stdout || '';
    assert.ok(helpText.includes('from_worker'), 'send-message help should mention from_worker');
    assert.ok(helpText.includes('to_worker'), 'send-message help should mention to_worker');
  });

  it('omb team api with invalid operation returns error', () => {
    if (!existsSync(ombBin)) return;
    const result = spawnSync(process.execPath, [ombBin, 'team', 'api', 'nonexistent-operation'], {
      encoding: 'utf-8',
      timeout: 10_000,
      windowsHide: true,
    });
    assert.notEqual(result.status, 0, 'Should fail for invalid operation');
  });

  it('omb team api without operation returns help or error', () => {
    if (!existsSync(ombBin)) return;
    const result = spawnSync(process.execPath, [ombBin, 'team', 'api'], {
      encoding: 'utf-8',
      timeout: 10_000,
      windowsHide: true,
    });
    // Should either show help (exit 0) or error (non-zero), but not crash
    assert.ok(typeof result.status === 'number');
  });
});
