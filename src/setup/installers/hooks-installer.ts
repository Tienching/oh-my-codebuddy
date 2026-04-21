/**
 * Hooks installer for oh-my-codebuddy setup.
 */

import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join, dirname } from "path";
import type { SetupAction } from "../plan.js";
import type { AssetInstaller, InstallerOptions } from "./types.js";
import { mergeManagedCodebuddyHooksConfig } from "../../config/codebuddy-hooks.js";
import { readFile } from "fs/promises";

export const hooksInstaller: AssetInstaller = {
  name: "hooks",

  async generateActions(options: InstallerOptions): Promise<SetupAction[]> {
    const { pkgRoot, projectRoot, scope } = options;
    const { resolveScopeDirectories } = await import("../../cli/setup.js");
    const scopeDirs = resolveScopeDirectories(scope, projectRoot);
    const actions: SetupAction[] = [];

    // Primary hooks file
    actions.push({
      kind: "update",
      description: `Update native hooks ${scopeDirs.codexHooksFile}`,
      destination: scopeDirs.codexHooksFile,
      status: "pending",
    });

    // Legacy project hooks
    if (scope === "project") {
      const legacyCodexDir = join(projectRoot, ".codex");
      const legacyHooksFile = join(legacyCodexDir, "hooks.json");
      if (
        legacyHooksFile !== scopeDirs.codexHooksFile &&
        (existsSync(legacyCodexDir) || existsSync(legacyHooksFile))
      ) {
        actions.push({
          kind: "update",
          description: `Update legacy hooks ${legacyHooksFile}`,
          destination: legacyHooksFile,
          status: "pending",
        });
      }
    }

    return actions;
  },

  async applyAction(action: SetupAction): Promise<void> {
    if (action.kind === "update") {
      const pkgRoot = findPkgRoot();
      const hooksConfig = mergeManagedCodebuddyHooksConfig(null, pkgRoot);

      await mkdir(dirname(action.destination), { recursive: true });

      // If file exists, merge with existing content
      if (existsSync(action.destination)) {
        const existing = await readFile(action.destination, "utf-8");
        const merged = mergeManagedCodebuddyHooksConfig(existing, pkgRoot);
        await writeFile(action.destination, merged, "utf-8");
      } else {
        await writeFile(action.destination, hooksConfig, "utf-8");
      }
    }
  },
};

function findPkgRoot(): string {
  // Use the package root resolution utility
  const { getPackageRoot } = require("../../utils/package.js") as typeof import("../../utils/package.js");
  return getPackageRoot();
}
