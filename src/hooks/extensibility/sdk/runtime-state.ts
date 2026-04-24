import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import type {
  HookPluginOmbHudState,
  HookPluginOmbNotifyFallbackState,
  HookPluginOmbSessionState,
  HookPluginOmbUpdateCheckState,
  HookPluginSdk,
} from '../types.js';
import { ombRootStateFilePath } from './paths.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readOmbStateFile<T extends Record<string, unknown>>(
  path: string,
  normalize?: (value: Record<string, unknown>) => T | null,
): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    if (!isRecord(parsed)) return null;
    return normalize ? normalize(parsed) : parsed as T;
  } catch {
    return null;
  }
}

function normalizeSessionState(value: Record<string, unknown>): HookPluginOmbSessionState | null {
  return typeof value.session_id === 'string' && value.session_id.trim()
    ? value as HookPluginOmbSessionState
    : null;
}

export function createHookPluginOmbApi(cwd: string): HookPluginSdk['omb'] {
  return {
    session: {
      read: () => readOmbStateFile<HookPluginOmbSessionState>(
        ombRootStateFilePath(cwd, 'session.json'),
        normalizeSessionState,
      ),
    },
    hud: {
      read: () => readOmbStateFile<HookPluginOmbHudState>(
        ombRootStateFilePath(cwd, 'hud-state.json'),
      ),
    },
    notifyFallback: {
      read: () => readOmbStateFile<HookPluginOmbNotifyFallbackState>(
        ombRootStateFilePath(cwd, 'notify-fallback-state.json'),
      ),
    },
    updateCheck: {
      read: () => readOmbStateFile<HookPluginOmbUpdateCheckState>(
        ombRootStateFilePath(cwd, 'update-check.json'),
      ),
    },
  };
}
