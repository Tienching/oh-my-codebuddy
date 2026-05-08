import { join, resolve } from "node:path";

export interface HandoffPaths {
  rootDir: string;
  artifactDir: string;
  indexPath: string;
  latestMarkdownPath: string;
  statePath: string;
  markdownPathFor(id: string): string;
  jsonPathFor(id: string): string;
}

function validateHandoffId(id: string): string {
  const trimmed = id.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`Invalid handoff id: ${id}`);
  }
  return trimmed;
}

export function resolveHandoffPaths(cwd: string): HandoffPaths {
  const rootDir = join(resolve(cwd), ".omb");
  const artifactDir = join(rootDir, "handoffs");
  const stateDir = join(rootDir, "state");
  return {
    rootDir,
    artifactDir,
    indexPath: join(artifactDir, "index.json"),
    latestMarkdownPath: join(artifactDir, "latest.md"),
    statePath: join(stateDir, "handoff-state.json"),
    markdownPathFor: (id: string) => join(artifactDir, `${validateHandoffId(id)}.md`),
    jsonPathFor: (id: string) => join(artifactDir, `${validateHandoffId(id)}.json`),
  };
}
