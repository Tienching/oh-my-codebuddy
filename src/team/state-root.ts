import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { ombStateDir } from '../utils/paths.js';

/**
 * Resolve the canonical team state root for a leader working directory.
 * Team runtime state is rooted in .omb/state unless an explicit shared root
 * overrides it (via OMB_TEAM_STATE_ROOT env) or a team tree already exists.
 *
 * The legacy .omc state directory migration was completed April 2026;
 * there is no separate legacy state path to mirror.
 */
export function resolveCanonicalTeamStateRoot(
  leaderCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.OMB_TEAM_STATE_ROOT ?? env.OMB_TEAM_STATE_ROOT;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return resolve(leaderCwd, explicit.trim());
  }
  return resolve(ombStateDir(leaderCwd));
}

/**
 * @deprecated Use resolveCanonicalTeamStateRoot instead.
 * This alias existed to support a legacy/canonical mirror that never
 * produced different paths. The brand migration is complete, so the
 * distinction is no longer meaningful.
 */
export const resolveActiveTeamStateRoot = resolveCanonicalTeamStateRoot;
