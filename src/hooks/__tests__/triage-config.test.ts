import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTriageConfig, resetTriageConfigCache } from '../triage-config.js';

let savedCodebuddyHome: string | undefined;

before(() => {
  savedCodebuddyHome = process.env.CODEBUDDY_HOME;
  resetTriageConfigCache();
});

after(() => {
  if (savedCodebuddyHome === undefined) {
    delete process.env.CODEBUDDY_HOME;
  } else {
    process.env.CODEBUDDY_HOME = savedCodebuddyHome;
  }
  resetTriageConfigCache();
});

let tmp: string;

function setupTmp(): void {
  tmp = mkdtempSync(join(tmpdir(), 'triage-config-test-'));
  process.env.CODEBUDDY_HOME = tmp;
  resetTriageConfigCache();
}

function teardownTmp(): void {
  rmSync(tmp, { recursive: true, force: true });
  resetTriageConfigCache();
}

function configPath(): string {
  return join(tmp, '.omx-config.json');
}

function writeConfig(content: string): void {
  writeFileSync(configPath(), content, 'utf-8');
}

describe('readTriageConfig — missing config file', () => {
  beforeEach(setupTmp);
  after(teardownTmp);

  it('returns defaulted result when .omx-config.json does not exist', () => {
    const result = readTriageConfig();
    assert.deepEqual(result, {
      enabled: true,
      status: 'defaulted',
      source: 'default',
      path: configPath(),
    });
  });
});

describe('readTriageConfig — valid config enabled: true', () => {
  beforeEach(setupTmp);
  after(teardownTmp);

  it('returns enabled result for {"promptRouting":{"triage":{"enabled":true}}}', () => {
    writeConfig(JSON.stringify({ promptRouting: { triage: { enabled: true } } }));
    const result = readTriageConfig();
    assert.deepEqual(result, {
      enabled: true,
      status: 'enabled',
      source: 'file',
      path: configPath(),
    });
  });
});

describe('readTriageConfig — valid config enabled: false', () => {
  beforeEach(setupTmp);
  after(teardownTmp);

  it('returns disabled result for {"promptRouting":{"triage":{"enabled":false}}}', () => {
    writeConfig(JSON.stringify({ promptRouting: { triage: { enabled: false } } }));
    const result = readTriageConfig();
    assert.deepEqual(result, {
      enabled: false,
      status: 'disabled',
      source: 'file',
      path: configPath(),
    });
  });
});

describe('readTriageConfig — malformed JSON', () => {
  beforeEach(setupTmp);
  after(teardownTmp);

  it('returns invalid/closed result for malformed JSON and does not throw', () => {
    writeConfig('this is not json');
    const result = readTriageConfig();
    assert.deepEqual(result, {
      enabled: false,
      status: 'invalid',
      source: 'invalid',
      path: configPath(),
    });
  });
});

describe('readTriageConfig — wrong shape', () => {
  beforeEach(setupTmp);
  after(teardownTmp);

  it('returns invalid for root value that is an array (not an object)', () => {
    writeConfig('[]');
    const result = readTriageConfig();
    assert.equal(result.status, 'invalid');
    assert.equal(result.enabled, false);
  });

  it('returns defaulted for object missing promptRouting key', () => {
    resetTriageConfigCache();
    writeConfig(JSON.stringify({ unrelated: 123 }));
    const result = readTriageConfig();
    assert.equal(result.status, 'defaulted');
    assert.equal(result.enabled, true);
  });

  it('returns defaulted when promptRouting exists but triage key is omitted', () => {
    writeConfig(JSON.stringify({ promptRouting: {} }));
    const result = readTriageConfig();
    assert.equal(result.status, 'defaulted');
    assert.equal(result.enabled, true);
  });

  it('returns defaulted when triage exists but enabled is omitted', () => {
    writeConfig(JSON.stringify({ promptRouting: { triage: {} } }));
    const result = readTriageConfig();
    assert.equal(result.status, 'defaulted');
    assert.equal(result.enabled, true);
  });

  it('returns invalid when promptRouting is present but not an object', () => {
    writeConfig(JSON.stringify({ promptRouting: true }));
    const result = readTriageConfig();
    assert.equal(result.status, 'invalid');
    assert.equal(result.enabled, false);
  });

  it('returns invalid when triage is present but not an object', () => {
    writeConfig(JSON.stringify({ promptRouting: { triage: true } }));
    const result = readTriageConfig();
    assert.equal(result.status, 'invalid');
    assert.equal(result.enabled, false);
  });
});

describe('readTriageConfig — non-boolean enabled value', () => {
  beforeEach(setupTmp);
  after(teardownTmp);

  it('returns invalid for {"promptRouting":{"triage":{"enabled":"yes"}}}', () => {
    writeConfig(JSON.stringify({ promptRouting: { triage: { enabled: 'yes' } } }));
    const result = readTriageConfig();
    assert.equal(result.status, 'invalid');
    assert.equal(result.enabled, false);
  });
});

describe('readTriageConfig — cache behavior (file-gone test)', () => {
  beforeEach(setupTmp);
  after(teardownTmp);

  it('returns cached result after config file is deleted, then defaulted after cache reset', () => {
    writeConfig(JSON.stringify({ promptRouting: { triage: { enabled: true } } }));

    const result1 = readTriageConfig();
    assert.equal(result1.status, 'enabled');

    rmSync(configPath(), { force: true });

    const result2 = readTriageConfig();
    assert.deepEqual(result1, result2, 'second read should return cached value equal to first read');

    resetTriageConfigCache();
    const result3 = readTriageConfig();
    assert.equal(result3.status, 'defaulted', 'after cache reset with missing file status should be "defaulted"');
    assert.equal(result3.enabled, true);
  });
});

describe('readTriageConfig — resetTriageConfigCache clears stale result', () => {
  beforeEach(setupTmp);
  after(teardownTmp);

  it('stale cache persists until reset, then reflects updated file', () => {
    writeConfig(JSON.stringify({ promptRouting: { triage: { enabled: true } } }));

    const before = readTriageConfig();
    assert.equal(before.status, 'enabled', 'initial read should be enabled');

    writeConfig(JSON.stringify({ promptRouting: { triage: { enabled: false } } }));

    const cached = readTriageConfig();
    assert.equal(cached.status, 'enabled', 'without reset, stale cache should still say enabled');

    resetTriageConfigCache();
    const fresh = readTriageConfig();
    assert.equal(fresh.status, 'disabled', 'after reset, read should reflect updated file (disabled)');
    assert.equal(fresh.enabled, false);
  });
});
