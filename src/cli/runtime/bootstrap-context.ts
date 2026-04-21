/**
 * CLI bootstrap context.
 *
 * Isolates all process.* reads into one place so the rest of the
 * CLI can be tested and composed without reaching for global state.
 */

import { resolve } from "path";
import { isTmuxAvailable } from "../../team/tmux-session.js";

export interface CliBootstrapContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  isTty: boolean;
  isTmux: boolean;
  logger: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  pathResolver: {
    resolve: (...segments: string[]) => string;
  };
}

export function buildBootstrapContext(
  overrides?: Partial<CliBootstrapContext>,
): CliBootstrapContext {
  return {
    cwd: overrides?.cwd ?? process.cwd(),
    env: overrides?.env ?? process.env,
    platform: overrides?.platform ?? process.platform,
    isTty: overrides?.isTty ?? Boolean(process.stdin.isTTY),
    isTmux: overrides?.isTmux ?? isTmuxAvailable(),
    logger: overrides?.logger ?? {
      info: (...args: unknown[]) => console.log(...args),
      error: (...args: unknown[]) => console.error(...args),
    },
    pathResolver: overrides?.pathResolver ?? {
      resolve: (...segments: string[]) => resolve(...segments),
    },
  };
}
