/**
 * Skills installer for oh-my-codebuddy setup.
 */

import { join } from "path";
import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { mkdir, copyFile, rm, readFile } from "fs/promises";
import { dirname } from "path";
import type { SetupAction } from "../plan.js";
import type { AssetInstaller, InstallerOptions } from "./types.js";
import { tryReadCatalogManifest } from "../../catalog/reader.js";
import { validateSkillFile } from "../../cli/setup.js";

export const skillsInstaller: AssetInstaller = {
  name: "skills",

  async generateActions(options: InstallerOptions): Promise<SetupAction[]> {
    const { pkgRoot, force = false } = options;
    const { resolveScopeDirectories } = await import("../../cli/setup.js");
    const scopeDirs = resolveScopeDirectories(options.scope, options.projectRoot);
    const skillsSrc = join(pkgRoot, "skills");
    const skillsDst = scopeDirs.skillsDir;
    const actions: SetupAction[] = [];

    if (!existsSync(skillsSrc)) return actions;

    const manifest = tryReadCatalogManifest();
    const skillStatusByName = manifest
      ? new Map(manifest.skills.map((skill) => [skill.name, skill.status]))
      : null;
    const isInstallableStatus = (status: string | undefined): boolean =>
      status === "active" || status === "internal";

    const entries = readdirSync(skillsSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const status = skillStatusByName?.get(entry.name);
      if (skillStatusByName && !isInstallableStatus(status)) {
        actions.push({
          kind: "skip",
          description: `Skip skill ${entry.name} (status: ${status ?? "unlisted"})`,
          destination: join(skillsDst, entry.name),
          status: "skipped",
        });
        continue;
      }

      const skillMd = join(skillsSrc, entry.name, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      const skillSrcDir = join(skillsSrc, entry.name);
      const skillDstDir = join(skillsDst, entry.name);
      const skillFiles = readdirSync(skillSrcDir);

      for (const sf of skillFiles) {
        const sfPath = join(skillSrcDir, sf);
        if (!statSync(sfPath).isFile()) continue;

        const dstPath = join(skillDstDir, sf);
        const needsCopy =
          force || !existsSync(dstPath) || filesDifferSync(sfPath, dstPath);

        if (needsCopy) {
          actions.push({
            kind: "copy",
            description: `Install skill ${entry.name}/${sf}`,
            source: sfPath,
            destination: dstPath,
            status: "pending",
          });
        } else {
          actions.push({
            kind: "skip",
            description: `Skill ${entry.name}/${sf} already up to date`,
            destination: dstPath,
            status: "skipped",
          });
        }
      }
    }

    return actions;
  },

  async applyAction(action: SetupAction): Promise<void> {
    if (action.kind === "copy" && action.source) {
      await mkdir(dirname(action.destination), { recursive: true });
      await copyFile(action.source, action.destination);
    } else if (action.kind === "remove") {
      await rm(action.destination, { force: true, recursive: true });
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
