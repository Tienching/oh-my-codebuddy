import { rename, unlink, writeFile } from 'node:fs/promises';

/**
 * Write `data` to `path` atomically using a temp file + rename.
 * On rename failure the temp file is cleaned up.
 */
export async function writeAtomicFile(path: string, data: string): Promise<void> {
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, data, 'utf-8');
  try {
    await rename(tmpPath, path);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/**
 * Create a path-scoped write queue that serializes writes to the same path.
 * Prevents concurrent writes from interleaving.
 */
export function createPathScopedWriteQueue(): {
  withWriteLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
} {
  const queues = new Map<string, Promise<void>>();

  async function withWriteLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const tail = queues.get(path) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = tail.finally(() => gate);
    queues.set(path, queued);

    await tail.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (queues.get(path) === queued) {
        queues.delete(path);
      }
    }
  }

  return { withWriteLock };
}
