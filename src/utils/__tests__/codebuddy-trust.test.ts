import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function importTrustModule() {
  return import(`../codebuddy-trust.js?trust-test=${Date.now()}-${Math.random()}`);
}

describe('codebuddy-trust', () => {
  let tempHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'omb-trust-'));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    if (typeof previousHome === 'string') process.env.HOME = previousHome;
    else delete process.env.HOME;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('creates ~/.claude.json and trusts a single resolved path', async () => {
    const { ensureCodebuddyTrust } = await importTrustModule();
    const repoPath = join(tempHome, 'workspace', '..', 'workspace', 'repo');

    assert.equal(ensureCodebuddyTrust(repoPath), true);

    const trustDbPath = join(tempHome, '.claude.json');
    assert.equal(existsSync(trustDbPath), true);

    const parsed = JSON.parse(readFileSync(trustDbPath, 'utf8'));
    assert.equal(
      parsed.projects[resolve(repoPath)].hasTrustDialogAccepted,
      true,
    );
  });

  it('repairs malformed ~/.claude.json and only counts newly added paths', async () => {
    const trustDbPath = join(tempHome, '.claude.json');
    writeFileSync(trustDbPath, '{ definitely not json', 'utf8');

    const { ensureCodebuddyTrustMany, defaultTrustedPaths } = await importTrustModule();
    const repoRoot = join(tempHome, 'repo');
    const trustedPaths = defaultTrustedPaths(repoRoot);

    assert.equal(ensureCodebuddyTrustMany(trustedPaths), trustedPaths.length);
    assert.equal(ensureCodebuddyTrustMany(trustedPaths), 0);

    const parsed = JSON.parse(readFileSync(trustDbPath, 'utf8'));
    for (const trustedPath of trustedPaths) {
      assert.equal(parsed.projects[resolve(trustedPath)].hasTrustDialogAccepted, true);
    }
  });
});
