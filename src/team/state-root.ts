import { resolve } from 'path';
import { ombStateDir } from '../utils/paths.js';

/**
 * Resolve the canonical team state root for a leader working directory.
 * Team runtime state is rooted in .omb/state unless an explicit shared root
 * overrides it (via OMB_TEAM_STATE_ROOT env).
 *
 * The legacy .omc state directory migration was completed April 2026;
 * there is no separate legacy state path to mirror.
 */
export function resolveCanonicalTeamStateRoot(
  leaderCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.OMB_TEAM_STATE_ROOT;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return resolve(leaderCwd, explicit.trim());
  }
  return resolve(ombStateDir(leaderCwd));
}

/** @deprecated Use resolveCanonicalTeamStateRoot — the alias served no purpose. */
export const resolveActiveTeamStateRoot = resolveCanonicalTeamStateRoot;
