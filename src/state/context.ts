import { resolveWorkingDirectoryForState, validateSessionId } from '../mcp/state-paths.js';

export interface StateContext {
  cwd: string;
  sessionId?: string;
  scope: 'project' | 'user';
  readPolicy: 'canonical_first' | 'legacy_first';
  writePolicy: 'canonical_only' | 'dual_write_compat';
  runtimeHints?: {
    mode?: string;
    isRalphActive?: boolean;
    isTeamActive?: boolean;
  };
}

export function buildStateContext(
  workingDirectory?: string,
  explicitSessionId?: string,
  options?: Partial<StateContext>,
): StateContext {
  const cwd = resolveWorkingDirectoryForState(workingDirectory);
  const sessionId = validateSessionId(explicitSessionId);

  const defaults: StateContext = {
    cwd,
    sessionId,
    scope: 'project',
    readPolicy: 'canonical_first',
    writePolicy: 'canonical_only',
  };

  return { ...defaults, ...options };
}
