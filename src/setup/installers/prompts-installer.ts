/**
 * Prompts installer for oh-my-codebuddy setup.
 */

import { join } from "path";
import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { mkdir, copyFile, rm } from "fs/promises";
import { dirname } from "path";
import type { SetupAction } from "../plan.js";
import type { AssetInstaller, InstallerOptions } from "./types.js";

export const promptsInstaller: AssetInstaller = {
  name: "prompts",

  async generateActions(options: InstallerOptions): Promise<SetupAction[]> {
    const { pkgRoot, force = false } = options;
    const { resolveScopeDirectories } = await import("../../cli/setup.js");
    const scopeDirs = resolveScopeDirectories(options.scope, options.projectRoot);
    const promptsSrc = join(pkgRoot, "prompts");
    const promptsDst = scopeDirs.promptsDir;
    const actions: SetupAction[] = [];

    if (!existsSync(promptsSrc)) return actions;

    const files = readdirSync(promptsSrc);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const srcPath = join(promptsSrc, file);
      if (!statSync(srcPath).isFile()) continue;

      const dstPath = join(promptsDst, file);
      const needsCopy =
        force || !existsSync(dstPath) || filesDifferSync(srcPath, dstPath);

      if (needsCopy) {
        actions.push({
          kind: "copy",
          description: `Install prompt ${file}`,
          source: srcPath,
          destination: dstPath,
          status: "pending",
        });
      } else {
        actions.push({
          kind: "skip",
          description: `Prompt ${file} already up to date`,
          destination: dstPath,
          status: "skipped",
        });
      }
    }

    return actions;
  },

  async applyAction(action: SetupAction): Promise<void> {
    if (action.kind === "copy" && action.source) {
      await mkdir(dirname(action.destination), { recursive: true });
      await copyFile(action.source, action.destination);
    } else if (action.kind === "remove") {
      await rm(action.destination, { force: true });
    }
  },
};

function filesDifferSync(src: string, dst: string): boolean {
  if (!existsSync(dst)) return true;
  try {
    const srcContent = readFileSync(src, "utf-8");
    const dstContent = readFileSync(dst, "utf-8");
    return srcContent !== dstContent;
  } catch {
    return true;
  }
}
