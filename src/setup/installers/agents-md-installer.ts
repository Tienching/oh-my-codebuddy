/**
 * AGENTS.md installer for oh-my-codebuddy setup.
 */

import { join } from "path";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import type { SetupAction } from "../plan.js";
import type { AssetInstaller, InstallerOptions } from "./types.js";
import {
  addGeneratedAgentsMarker,
  isOmxGeneratedAgentsMd,
} from "../../utils/agents-md.js";
import {
  resolveAgentsModelTableContext,
  upsertAgentsModelTable,
} from "../../utils/agents-model-table.js";

export const agentsMdInstaller: AssetInstaller = {
  name: "agents-md",

  async generateActions(options: InstallerOptions): Promise<SetupAction[]> {
    const { pkgRoot, projectRoot, scope } = options;
    const actions: SetupAction[] = [];

    const agentsMdSrc = join(pkgRoot, "templates", "AGENTS.md");
    const agentsMdDst =
      scope === "project"
        ? join(projectRoot, "AGENTS.md")
        : join(
            (
              await import("../../cli/setup.js")
            ).resolveScopeDirectories(scope, projectRoot).codexHomeDir,
            "AGENTS.md",
          );

    if (!existsSync(agentsMdSrc)) {
      actions.push({
        kind: "skip",
        description: "AGENTS.md template not found, skipping",
        destination: agentsMdDst,
        status: "skipped",
      });
      return actions;
    }

    actions.push({
      kind: "update",
      description: `Generate AGENTS.md`,
      source: agentsMdSrc,
      destination: agentsMdDst,
      status: "pending",
    });

    return actions;
  },

  async applyAction(action: SetupAction): Promise<void> {
    if (action.kind === "update" && action.source) {
      const { readFile } = await import("fs/promises");
      const content = await readFile(action.source, "utf-8");

      // Apply scope path rewrites
      const scope = action.destination.includes("/.codebuddy/AGENTS.md") || action.destination.includes("\\.codebuddy\\AGENTS.md")
        ? "user"
        : "project";

      const rewritten = applyScopePathRewrites(
        addGeneratedAgentsMarker(content),
        scope,
      );

      await mkdir(join(action.destination, ".."), { recursive: true });

      // Check if existing is OMB-generated managed content
      if (existsSync(action.destination)) {
        const existing = await readFile(action.destination, "utf-8");
        if (isOmxGeneratedAgentsMd(existing)) {
          // Safe to update managed content
        }
      }

      await writeFile(action.destination, rewritten, "utf-8");
    }
  },
};

function applyScopePathRewrites(content: string, scope: string): string {
  if (scope !== "project") return content;
  return content
    .replaceAll("~/.codebuddy", "./.codebuddy")
    .replaceAll("~/.codex", "./.codebuddy");
}
