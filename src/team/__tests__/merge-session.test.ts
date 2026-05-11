import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isMergeSessionState,
  readMergeSession,
  writeMergeSession,
  writeConflictReport,
  mergeSessionPath,
  type MergeSessionState,
  type ConflictReport,
} from '../merge-session.js';

function makeState(teamName: string): MergeSessionState {
  return {
    version: 1,
    teamName,
    baseBranch: 'main',
    tier: 'non-interactive',
    status: 'pending',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workers: [
      {
        name: 'worker-1',
        branch: 'feature/worker-1',
        worktreePath: null,
        status: 'pending',
      },
    ],
    options: {
      cleanup: false,
      detach: false,
      dryRun: false,
      nonInteractive: true,
    },
  };
}

function makeConflictReport(): ConflictReport {
  return {
    conflictId: 'conflict-abc123',
    teamName: 'myteam',
    workerName: 'worker-1',
    branch: 'feature/worker-1',
    baseBranch: 'main',
    conflictingFiles: ['src/index.ts', 'README.md'],
    mergeTreeOutput: 'CONFLICT (content): Merge conflict in src/index.ts',
    suggestedCommands: ['git checkout --theirs src/index.ts', 'git add src/index.ts'],
    createdAt: new Date().toISOString(),
  };
}

test('writeMergeSession + readMergeSession round-trip', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omb-merge-'));
  try {
    const state = makeState('team1');
    await writeMergeSession(state, cwd);
    const read = await readMergeSession('team1', cwd);
    assert.ok(read, 'should read back a non-null state');
    assert.equal(read.teamName, 'team1');
    assert.equal(read.baseBranch, 'main');
    assert.equal(read.tier, 'non-interactive');
    assert.equal(read.status, 'pending');
    assert.equal(read.version, 1);
    assert.equal(read.workers.length, 1);
    assert.equal(read.workers[0].name, 'worker-1');
    assert.equal(read.workers[0].branch, 'feature/worker-1');
    assert.equal(read.workers[0].status, 'pending');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('writeMergeSession atomic write: final file exists and is valid JSON', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omb-merge-'));
  try {
    const state = makeState('atomicteam');
    await writeMergeSession(state, cwd);
    const p = mergeSessionPath('atomicteam', cwd);
    assert.ok(existsSync(p), 'session.json should exist after write');
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(parsed, 'should parse as valid JSON');
    assert.equal(parsed.teamName, 'atomicteam');
    // No .tmp files should remain
    const dir = p.replace('/session.json', '');
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(dir);
    const tmpFiles = files.filter((f: string) => f.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 0, 'no .tmp files should remain after atomic write');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('isMergeSessionState returns true for valid state', () => {
  const state = makeState('valid-team');
  assert.equal(isMergeSessionState(state), true);
});

test('isMergeSessionState returns true for state with all optional fields', () => {
  const state: MergeSessionState = {
    ...makeState('full-team'),
    tier: 'leader-online',
    status: 'completed',
    completedAt: new Date().toISOString(),
    error: null,
    workers: [
      {
        name: 'w1',
        branch: 'feat/w1',
        worktreePath: '/tmp/wt',
        status: 'merged',
        mergeCommit: 'abc123',
        conflictReportPath: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ],
  };
  assert.equal(isMergeSessionState(state), true);
});

test('isMergeSessionState returns false for missing version', () => {
  const state = makeState('bad-team') as unknown as Record<string, unknown>;
  delete state.version;
  assert.equal(isMergeSessionState(state), false);
});

test('isMergeSessionState returns false for wrong version', () => {
  const state = { ...makeState('bad-team'), version: 2 };
  assert.equal(isMergeSessionState(state), false);
});

test('isMergeSessionState returns false for wrong status', () => {
  const state = { ...makeState('bad-team'), status: 'running' };
  assert.equal(isMergeSessionState(state), false);
});

test('isMergeSessionState returns false for non-array workers', () => {
  const state = { ...makeState('bad-team'), workers: 'not-an-array' };
  assert.equal(isMergeSessionState(state), false);
});

test('isMergeSessionState returns false for null', () => {
  assert.equal(isMergeSessionState(null), false);
});

test('isMergeSessionState returns false for empty object', () => {
  assert.equal(isMergeSessionState({}), false);
});

test('isMergeSessionState returns false for wrong tier', () => {
  const state = { ...makeState('bad-team'), tier: 'invalid-tier' };
  assert.equal(isMergeSessionState(state), false);
});

test('isMergeSessionState returns false for worker with wrong status', () => {
  const state = makeState('bad-team');
  (state.workers[0] as unknown as Record<string, unknown>).status = 'unknown-status';
  assert.equal(isMergeSessionState(state), false);
});

test('writeConflictReport produces both .md and .json files', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omb-merge-'));
  try {
    const report = makeConflictReport();
    const { markdownPath, jsonPath } = await writeConflictReport(report, 'myteam', cwd);
    assert.ok(existsSync(markdownPath), '.md file should exist');
    assert.ok(existsSync(jsonPath), '.json file should exist');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('writeConflictReport .md contains worker and branch info', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omb-merge-'));
  try {
    const report = makeConflictReport();
    const { markdownPath } = await writeConflictReport(report, 'myteam', cwd);
    const md = readFileSync(markdownPath, 'utf8');
    assert.ok(md.includes('worker-1'), 'md should contain workerName');
    assert.ok(md.includes('feature/worker-1'), 'md should contain branch');
    assert.ok(md.includes('main'), 'md should contain baseBranch');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('writeConflictReport .md contains each suggestedCommand', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omb-merge-'));
  try {
    const report = makeConflictReport();
    const { markdownPath } = await writeConflictReport(report, 'myteam', cwd);
    const md = readFileSync(markdownPath, 'utf8');
    for (const cmd of report.suggestedCommands) {
      assert.ok(md.includes(cmd), `md should contain command: ${cmd}`);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('writeConflictReport .json is valid and matches report', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omb-merge-'));
  try {
    const report = makeConflictReport();
    const { jsonPath } = await writeConflictReport(report, 'myteam', cwd);
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(parsed.conflictId, report.conflictId);
    assert.equal(parsed.workerName, report.workerName);
    assert.equal(parsed.branch, report.branch);
    assert.deepEqual(parsed.conflictingFiles, report.conflictingFiles);
    assert.deepEqual(parsed.suggestedCommands, report.suggestedCommands);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('readMergeSession returns null when file does not exist', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omb-merge-'));
  try {
    const result = await readMergeSession('nonexistent-team', cwd);
    assert.equal(result, null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('readMergeSession returns null when JSON is corrupt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omb-merge-'));
  try {
    // Write a valid state first to create the directory, then corrupt it
    const state = makeState('corrupt-team');
    await writeMergeSession(state, cwd);
    const p = mergeSessionPath('corrupt-team', cwd);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(p, '{ this is not valid json !!!', 'utf8');
    const result = await readMergeSession('corrupt-team', cwd);
    assert.equal(result, null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
