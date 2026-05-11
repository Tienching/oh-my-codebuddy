import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../omb.js', import.meta.url));

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null } {
  const proc = spawnSync('node', [cli, 'team', ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { stdout: proc.stdout ?? '', stderr: proc.stderr ?? '', status: proc.status };
}

describe('omb team merge CLI', () => {
  let tmpCwd: string;

  beforeEach(async () => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'omb-merge-test-'));
    // Pre-trust the temp cwd so any spawned codebuddy/claude subprocess
    // does not deadlock on the TTY-only "Trust folder?" dialog.
    try {
      const { ensureCodebuddyTrust } = await import('../../utils/codebuddy-trust.js');
      ensureCodebuddyTrust(tmpCwd);
    } catch {
      // Non-fatal — without trust pre-write the test may still pass via
      // spawnSync timeout, just leaves orphan workers.
    }
  });

  afterEach(() => {
    try {
      rmSync(tmpCwd, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('missing team name → exit 1, stderr contains Usage:', () => {
    const r = run(['merge'], tmpCwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage:/);
  });

  it('unknown team → exit 1, stderr contains team_not_found: ghost-team', () => {
    const r = run(['merge', 'ghost-team'], tmpCwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /team_not_found: ghost-team/);
  });

  it('--status with no session → exit 0, stdout JSON {"status":"none"}', () => {
    const r = run(['merge', 'no-session-team', '--status'], tmpCwd);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.status, 'none');
  });

  it('--status with mock session → exit 0, stdout is valid JSON with teamName field', () => {
    // Write a minimal team config so readMergeSession can find the state root
    // The session file path is: <stateRoot>/team/<sanitized-name>/merge/session.json
    // resolveActiveTeamStateRoot uses cwd/.omb/state by default
    const teamName = 'my-test-team';

    // Write the session.json manually
    const sessionDir = join(tmpCwd, '.omb', 'state', 'team', teamName, 'merge');
    mkdirSync(sessionDir, { recursive: true });

    const session = {
      version: 1,
      teamName,
      baseBranch: 'main',
      tier: 'non-interactive',
      status: 'completed',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      workers: [],
      options: {
        cleanup: false,
        detach: false,
        dryRun: false,
        only: null,
        nonInteractive: true,
      },
      error: null,
    };
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(session, null, 2), 'utf8');

    const r = run(['merge', teamName, '--status'], tmpCwd);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.teamName, teamName);
  });

  it('unknown flag → exit 1, stderr contains "unknown flag"', () => {
    const r = run(['merge', 'some-team', '--bogus'], tmpCwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag/);
  });

  it('missing --base value → exit 1, stderr contains missing value', () => {
    const r = run(['merge', 'some-team', '--base'], tmpCwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing value for flag: --base/);
  });

  it('missing --only value → exit 1 when next token is another flag', () => {
    const r = run(['merge', 'some-team', '--only', '--cleanup'], tmpCwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing value for flag: --only/);
  });
});
