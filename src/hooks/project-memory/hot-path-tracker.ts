/**
 * Hot Path Tracker
 *
 * Tracks frequently accessed files and directories for project memory.
 */

import path from 'path';
import type { HotPath } from './types.js';

const MAX_HOT_PATHS = 50;

const IGNORE_PATTERNS = [
  'node_modules', '.git', '.omb', 'dist', 'build', '.cache',
  '.next', '.nuxt', 'coverage', '.DS_Store', '__pycache__',
];

/**
 * Track file or directory access
 */
export function trackAccess(
  hotPaths: HotPath[],
  filePath: string,
  projectRoot: string,
  type: 'file' | 'directory',
): HotPath[] {
  const relativePath = path.isAbsolute(filePath)
    ? path.relative(projectRoot, filePath)
    : filePath;

  if (relativePath.startsWith('..') || shouldIgnorePath(relativePath)) {
    return hotPaths;
  }

  const existing = hotPaths.find((hp) => hp.path === relativePath);

  if (existing) {
    existing.accessCount++;
    existing.lastAccessed = Date.now();
  } else {
    hotPaths.push({
      path: relativePath,
      accessCount: 1,
      lastAccessed: Date.now(),
      type,
    });
  }

  hotPaths.sort((a, b) => b.accessCount - a.accessCount);

  if (hotPaths.length > MAX_HOT_PATHS) {
    hotPaths.splice(MAX_HOT_PATHS);
  }

  return hotPaths;
}

function shouldIgnorePath(relativePath: string): boolean {
  return IGNORE_PATTERNS.some((pattern) => relativePath.includes(pattern));
}

/**
 * Get top hot paths sorted by score (recency + frequency + scope)
 */
export function getTopHotPaths(
  hotPaths: HotPath[],
  limit = 10,
  scopePath?: string,
): HotPath[] {
  const now = Date.now();

  return [...hotPaths]
    .filter((hp) => !shouldIgnorePath(hp.path))
    .sort((a, b) => scoreHotPath(b, scopePath, now) - scoreHotPath(a, scopePath, now))
    .slice(0, limit);
}

function scoreHotPath(hp: HotPath, scopePath: string | undefined, now: number): number {
  const ageMs = Math.max(0, now - hp.lastAccessed);
  const recencyScore = Math.max(0, 120 - Math.floor(ageMs / (60 * 60 * 1000)));
  const accessScore = hp.accessCount * 10;
  const typeBonus = hp.type === 'file' ? 6 : 3;
  const scopeBonus = scopePath ? getScopeAffinityScore(hp.path, scopePath) : 0;

  return accessScore + recencyScore + typeBonus + scopeBonus;
}

function getScopeAffinityScore(hpPath: string, scopePath: string): number {
  if (hpPath === scopePath) return 400;
  if (hpPath.startsWith(`${scopePath}/`)) return 320;
  if (scopePath.startsWith(`${hpPath}/`)) return 220;

  const hpSegs = hpPath.split('/');
  const scopeSegs = scopePath.split('/');
  let shared = 0;
  while (
    shared < hpSegs.length &&
    shared < scopeSegs.length &&
    hpSegs[shared] === scopeSegs[shared]
  ) {
    shared++;
  }
  return shared * 60;
}

/**
 * Decay old hot paths (reduce access count over time)
 */
export function decayHotPaths(hotPaths: HotPath[]): HotPath[] {
  const now = Date.now();
  const dayInMs = 24 * 60 * 60 * 1000;

  return hotPaths
    .map((hp) => {
      const age = now - hp.lastAccessed;
      if (age > dayInMs * 7) {
        return { ...hp, accessCount: Math.max(1, Math.floor(hp.accessCount / 2)) };
      }
      return hp;
    })
    .filter((hp) => hp.accessCount > 0);
}
