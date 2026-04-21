/**
 * Shared Memory Storage
 *
 * Provides namespace-key-value storage for cross-agent shared memory.
 * Storage: .omb/shared-memory/{namespace}/{key}.json
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface SharedMemoryEntry {
  namespace: string;
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

const SHARED_MEMORY_DIR = '.omb/shared-memory';
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getNamespaceDir(root: string, namespace: string): string {
  return join(root, SHARED_MEMORY_DIR, namespace);
}

function getEntryPath(root: string, namespace: string, key: string): string {
  return join(getNamespaceDir(root, namespace), `${key}.json`);
}

function isExpired(entry: SharedMemoryEntry): boolean {
  if (!entry.expiresAt) return false;
  return new Date(entry.expiresAt).getTime() < Date.now();
}

export function writeEntry(
  namespace: string,
  key: string,
  value: unknown,
  ttlSeconds?: number,
  root = process.cwd(),
): SharedMemoryEntry {
  const now = new Date();
  const entry: SharedMemoryEntry = {
    namespace,
    key,
    value,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: ttlSeconds
      ? new Date(now.getTime() + Math.min(ttlSeconds * 1000, MAX_TTL_MS)).toISOString()
      : undefined,
  };

  const dir = getNamespaceDir(root, namespace);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getEntryPath(root, namespace, key), JSON.stringify(entry, null, 2), 'utf-8');
  return entry;
}

export function readEntry(namespace: string, key: string, root = process.cwd()): SharedMemoryEntry | null {
  const path = getEntryPath(root, namespace, key);
  if (!existsSync(path)) return null;

  try {
    const entry = JSON.parse(readFileSync(path, 'utf-8')) as SharedMemoryEntry;
    if (isExpired(entry)) {
      unlinkSync(path);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

export function listEntries(namespace: string, root = process.cwd()): Array<{ key: string; updatedAt: string; expiresAt?: string }> {
  const dir = getNamespaceDir(root, namespace);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const entries: Array<{ key: string; updatedAt: string; expiresAt?: string }> = [];

  for (const file of files) {
    try {
      const entry = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as SharedMemoryEntry;
      if (!isExpired(entry)) {
        entries.push({ key: entry.key, updatedAt: entry.updatedAt, expiresAt: entry.expiresAt });
      } else {
        unlinkSync(join(dir, file));
      }
    } catch {
      // Skip invalid files
    }
  }

  return entries;
}

export function deleteEntry(namespace: string, key: string, root = process.cwd()): boolean {
  const path = getEntryPath(root, namespace, key);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function listNamespaces(root = process.cwd()): string[] {
  const base = join(root, SHARED_MEMORY_DIR);
  if (!existsSync(base)) return [];
  return readdirSync(base).filter(n => !n.startsWith('.'));
}

export function cleanupExpired(namespace?: string, root = process.cwd()): { removed: number; namespaces: string[] } {
  const removed = 0;
  const namespaces = namespace ? [namespace] : listNamespaces(root);
  const cleaned: string[] = [];

  for (const ns of namespaces) {
    const dir = getNamespaceDir(root, ns);
    if (!existsSync(dir)) continue;

    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    let nsRemoved = 0;

    for (const file of files) {
      try {
        const entry = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as SharedMemoryEntry;
        if (isExpired(entry)) {
          unlinkSync(join(dir, file));
          nsRemoved++;
        }
      } catch {
        // Skip
      }
    }

    if (nsRemoved > 0) cleaned.push(ns);
  }

  return { removed, namespaces: cleaned };
}
