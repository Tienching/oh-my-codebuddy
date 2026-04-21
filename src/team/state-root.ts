import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { ombStateDir, omxStateDir } from '../utils/paths.js';

/**
 * Resolve the canonical team state root for a leader working directory.
 * Team runtime state remains rooted in .omb/state unless an explicit shared root or an existing .omx/team tree overrides it.
 */
export function resolveCanonicalTeamStateRoot(
  leaderCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.OMB_TEAM_STATE_ROOT ?? env.OMX_TEAM_STATE_ROOT;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return resolve(leaderCwd, explicit.trim());
  }
  const canonical = resolve(ombStateDir(leaderCwd));
  const migrated = resolve(omxStateDir(leaderCwd));
  if (existsSync(join(canonical, 'team')) || !existsSync(migrated)) {
    return canonical;
  }
  return migrated;
}

export function resolveActiveTeamStateRoot(
  leaderCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.OMX_TEAM_STATE_ROOT ?? env.OMB_TEAM_STATE_ROOT;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return resolve(leaderCwd, explicit.trim());
  }
  const canonical = resolve(omxStateDir(leaderCwd));
  const legacy = resolve(ombStateDir(leaderCwd));
  if (existsSync(join(canonical, 'team')) || !existsSync(legacy)) {
    return canonical;
  }
  return legacy;
}
