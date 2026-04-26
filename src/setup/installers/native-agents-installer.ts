/**
 * Native agent configs installer for oh-my-codebuddy setup.
 */

import { join } from "path";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import type { SetupAction } from "../plan.js";
import type { AssetInstaller, InstallerOptions } from "./types.js";
import { AGENT_DEFINITIONS } from "../../agents/definitions.js";
import { generateAgentToml } from "../../agents/native-config.js";
import { readFile } from "fs/promises";

export const nativeAgentsInstaller: AssetInstaller = {
  name: "native-agents",

  async generateActions(options: InstallerOptions): Promise<SetupAction[]> {
    const { pkgRoot, force = false } = options;
    const { resolveScopeDirectories } = await import("../../cli/setup.js");
    const scopeDirs = resolveScopeDirectories(options.scope, options.projectRoot);
    const agentsDir = scopeDirs.nativeAgentsDir;
    const actions: SetupAction[] = [];

    for (const name of Object.keys(AGENT_DEFINITIONS)) {
      const promptPath = join(pkgRoot, "prompts", `${name}.md`);
      if (!existsSync(promptPath)) continue;

      const dstPath = join(agentsDir, `${name}.toml`);
      const needsUpdate = force || !existsSync(dstPath);

      if (needsUpdate) {
        actions.push({
          kind: "update",
          description: `Install native agent config ${name}.toml`,
          destination: dstPath,
          metadata: { agentName: name },
          status: "pending",
        });
      } else {
        actions.push({
          kind: "skip",
          description: `Native agent ${name}.toml already exists`,
          destination: dstPath,
          status: "skipped",
        });
      }
    }

    return actions;
  },

  async applyAction(action: SetupAction): Promise<void> {
    if (action.kind === "update" && action.metadata?.agentName) {
      const agentName = action.metadata.agentName as string;
      const agent = AGENT_DEFINITIONS[agentName];
      if (!agent) {
        throw new Error(`Unknown agent definition: ${agentName}`);
      }

      // Find the prompts dir from the destination path
      const agentsDir = join(action.destination, "..");
      const pkgRoot = findPkgRootFromAgentsDir(agentsDir);
      const promptPath = join(pkgRoot, "prompts", `${agentName}.md`);

      if (!existsSync(promptPath)) {
        throw new Error(`Prompt file not found: ${promptPath}`);
      }

      const promptContent = await readFile(promptPath, "utf-8");
      const toml = generateAgentToml(agent, promptContent, {
        codebuddyHomeOverride: join(agentsDir, ".."),
      });

      await mkdir(join(action.destination, ".."), { recursive: true });
      await writeFile(action.destination, toml, "utf-8");
    }
  },
};

function findPkgRootFromAgentsDir(agentsDir: string): string {
  // Walk up from agents/ to find package root (contains prompts/)
  let dir = join(agentsDir, "..", "..");
  // For installed packages, the structure is: pkgRoot/prompts/ and pkgRoot/skills/
  // For project scope: .codebuddy/agents/ -> project root is up two levels
  // For user scope: ~/.codebuddy/agents/ -> pkgRoot is the npm package root
  // This is a heuristic; the pkgRoot should be passed explicitly when possible.
  return dir;
}
