import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { resolveHandoffPaths } from "../paths.js";

describe("handoff paths", () => {
  it("resolves all paths inside the cwd .omb directory", () => {
    const cwd = resolve(join(tmpdir(), "omb-handoff-paths"));
    const paths = resolveHandoffPaths(cwd);
    assert.equal(paths.rootDir, join(cwd, ".omb"));
    assert.equal(paths.artifactDir, join(cwd, ".omb", "handoffs"));
    assert.equal(paths.indexPath, join(cwd, ".omb", "handoffs", "index.json"));
    assert.equal(paths.latestMarkdownPath, join(cwd, ".omb", "handoffs", "latest.md"));
    assert.equal(paths.statePath, join(cwd, ".omb", "state", "handoff-state.json"));
    assert.equal(paths.markdownPathFor("handoff-1"), join(cwd, ".omb", "handoffs", "handoff-1.md"));
    assert.equal(paths.jsonPathFor("handoff-1"), join(cwd, ".omb", "handoffs", "handoff-1.json"));
  });

  it("does not use HOME", () => {
    const paths = resolveHandoffPaths("/tmp/project");
    assert.doesNotMatch(paths.artifactDir, /home|HOME|codebuddy|codex|claude/i);
  });
});
