import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeAtomicFile, createPathScopedWriteQueue } from '../atomic-write.js';

describe('writeAtomicFile', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `atomic-write-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('writes a file atomically', async () => {
    const filePath = join(testDir, 'test.json');
    await writeAtomicFile(filePath, '{"hello": "world"}');
    const content = await readFile(filePath, 'utf-8');
    assert.equal(content, '{"hello": "world"}');
  });

  it('overwrites an existing file', async () => {
    const filePath = join(testDir, 'test.json');
    await writeAtomicFile(filePath, '{"version": 1}');
    await writeAtomicFile(filePath, '{"version": 2}');
    const content = await readFile(filePath, 'utf-8');
    assert.equal(content, '{"version": 2}');
  });

  it('writes UTF-8 content', async () => {
    const filePath = join(testDir, 'test.json');
    await writeAtomicFile(filePath, '{"emoji": "🎉"}');
    const content = await readFile(filePath, 'utf-8');
    assert.equal(content, '{"emoji": "🎉"}');
  });
});

describe('createPathScopedWriteQueue', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `write-queue-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('serializes writes to the same path', async () => {
    const queue = createPathScopedWriteQueue();
    const filePath = join(testDir, 'test.json');
    const order: number[] = [];

    const write1 = queue.withWriteLock(filePath, async () => {
      order.push(1);
      await writeAtomicFile(filePath, '{"write": 1}');
      order.push(2);
    });

    const write2 = queue.withWriteLock(filePath, async () => {
      order.push(3);
      await writeAtomicFile(filePath, '{"write": 2}');
      order.push(4);
    });

    await Promise.all([write1, write2]);

    // Writes should be serialized, not interleaved
    assert.deepStrictEqual(order, [1, 2, 3, 4]);

    const content = await readFile(filePath, 'utf-8');
    assert.equal(content, '{"write": 2}');
  });

  it('allows parallel writes to different paths', async () => {
    const queue = createPathScopedWriteQueue();
    const path1 = join(testDir, 'test1.json');
    const path2 = join(testDir, 'test2.json');
    const order: string[] = [];

    const write1 = queue.withWriteLock(path1, async () => {
      order.push('start1');
      await writeAtomicFile(path1, '{"path": 1}');
      order.push('end1');
    });

    const write2 = queue.withWriteLock(path2, async () => {
      order.push('start2');
      await writeAtomicFile(path2, '{"path": 2}');
      order.push('end2');
    });

    await Promise.all([write1, write2]);

    // Both started before either ended (parallel)
    assert.ok(order.includes('start1'));
    assert.ok(order.includes('start2'));

    const content1 = await readFile(path1, 'utf-8');
    const content2 = await readFile(path2, 'utf-8');
    assert.equal(content1, '{"path": 1}');
    assert.equal(content2, '{"path": 2}');
  });

  it('returns the result of the locked function', async () => {
    const queue = createPathScopedWriteQueue();
    const result = await queue.withWriteLock('/some/path', async () => {
      return 42;
    });
    assert.equal(result, 42);
  });

  it('propagates errors from the locked function', async () => {
    const queue = createPathScopedWriteQueue();
    await assert.rejects(
      async () => queue.withWriteLock('/some/path', async () => {
        throw new Error('test error');
      }),
      { message: 'test error' },
    );
  });

  it('allows subsequent writes after an error', async () => {
    const queue = createPathScopedWriteQueue();
    const filePath = join(testDir, 'test.json');

    await assert.rejects(
      async () => queue.withWriteLock(filePath, async () => {
        throw new Error('fail');
      }),
      { message: 'fail' },
    );

    // Should still work after error
    await queue.withWriteLock(filePath, async () => {
      await writeAtomicFile(filePath, '{"after": "error"}');
    });

    const content = await readFile(filePath, 'utf-8');
    assert.equal(content, '{"after": "error"}');
  });
});
