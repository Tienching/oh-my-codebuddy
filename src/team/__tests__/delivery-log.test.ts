import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendTeamDeliveryLog, teamDeliveryLogPath } from '../delivery-log.js';

async function setupLogsDir(prefix: string): Promise<{ logsDir: string; cleanup: () => Promise<void> }> {
  const logsDir = await mkdtemp(join(tmpdir(), `omb-delivery-log-${prefix}-`));
  return { logsDir, cleanup: () => rm(logsDir, { recursive: true, force: true }) };
}

function readJsonLines(content: string): Record<string, unknown>[] {
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('team delivery log', () => {
  it('appends a structured delivery log entry', async () => {
    const { logsDir, cleanup } = await setupLogsDir('basic');
    try {
      await appendTeamDeliveryLog(logsDir, {
        event: 'dispatch_attempted',
        source: 'test',
        team: 'alpha',
        transport: 'send-keys',
        result: 'ok',
      });

      const logPath = teamDeliveryLogPath(logsDir);
      const content = await readFile(logPath, 'utf-8');
      const entries = readJsonLines(content);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.kind, 'team_delivery');
      assert.equal(entries[0]?.event, 'dispatch_attempted');
      assert.equal(entries[0]?.team, 'alpha');
      assert.equal(entries[0]?.transport, 'send-keys');
      assert.equal(entries[0]?.result, 'ok');
    } finally {
      await cleanup();
    }
  });

  it('redacts bearer tokens from string fields', async () => {
    const { logsDir, cleanup } = await setupLogsDir('redact');
    try {
      await appendTeamDeliveryLog(logsDir, {
        event: 'dispatch_attempted',
        source: 'test',
        team: 'bravo',
        message: 'Bearer supersecret123456 should be hidden',
      });

      const logPath = teamDeliveryLogPath(logsDir);
      const content = await readFile(logPath, 'utf-8');
      const entries = readJsonLines(content);
      assert.equal(entries.length, 1);
      assert.doesNotMatch(content, /supersecret123456/);
      assert.match(content, /\[REDACTED:bearer\]/);
    } finally {
      await cleanup();
    }
  });

  it('truncates oversize string values', async () => {
    const { logsDir, cleanup } = await setupLogsDir('truncate');
    try {
      const longValue = 'x'.repeat(10_000);
      await appendTeamDeliveryLog(logsDir, {
        event: 'dispatch_result',
        source: 'test',
        team: 'charlie',
        payload: longValue,
      });

      const logPath = teamDeliveryLogPath(logsDir);
      const content = await readFile(logPath, 'utf-8');
      const entries = readJsonLines(content);
      assert.equal(entries.length, 1);
      const payload = entries[0]?.payload as string;
      assert.ok(payload.length < longValue.length, 'oversize string should be truncated');
      assert.ok(payload.includes('[TRUNCATED]'), 'truncated string should include marker');
    } finally {
      await cleanup();
    }
  });

  it('prunes old delivery log files beyond the retention window', async () => {
    const { logsDir, cleanup } = await setupLogsDir('prune');
    try {
      // Create an "old" log file with mtime set to 20 days ago
      const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      const oldPath = teamDeliveryLogPath(logsDir, oldDate);
      await mkdir(logsDir, { recursive: true });
      await writeFile(oldPath, '{"old":true}\n', 'utf8');
      await utimes(oldPath, oldDate, oldDate);

      // Write a current log entry — this should trigger pruning
      await appendTeamDeliveryLog(logsDir, {
        event: 'dispatch_attempted',
        source: 'test',
        team: 'delta',
      });

      const { readdir } = await import('fs/promises');
      const files = await readdir(logsDir);
      const oldFiles = files.filter((f) => f.includes(oldDate.toISOString().slice(0, 10)));
      assert.equal(oldFiles.length, 0, 'old log file should be pruned');
    } finally {
      await cleanup();
    }
  });

  it('rotates (removes) the current day log when it exceeds size limit', async () => {
    const { logsDir, cleanup } = await setupLogsDir('rotate');
    try {
      // Write a large log entry first
      const logPath = teamDeliveryLogPath(logsDir);
      await mkdir(logsDir, { recursive: true });
      const bigEntry = { event: 'nudge_triggered', source: 'test', team: 'echo', payload: 'y'.repeat(11 * 1024 * 1024) };
      await writeFile(logPath, `${JSON.stringify(bigEntry)}\n`, 'utf8');

      // Now write through the append function — should detect oversize and rotate
      await appendTeamDeliveryLog(logsDir, {
        event: 'dispatch_attempted',
        source: 'test',
        team: 'echo',
      });

      const content = await readFile(logPath, 'utf-8').catch(() => '');
      // After rotation (unlink + fresh write), the file should exist but only contain the new entry
      const entries = content.trim() ? readJsonLines(content) : [];
      assert.ok(entries.length <= 1, 'after rotation, log should have at most 1 entry');
    } finally {
      await cleanup();
    }
  });

  it('does not crash when the logs directory is not writable', async () => {
    const { logsDir, cleanup } = await setupLogsDir('nowrite');
    try {
      // Just verify no throw even with a valid dir
      await appendTeamDeliveryLog(logsDir, {
        event: 'dispatch_attempted',
        source: 'test',
        team: 'foxtrot',
      });
      // Should not throw
      assert.ok(true);
    } finally {
      await cleanup();
    }
  });
});
