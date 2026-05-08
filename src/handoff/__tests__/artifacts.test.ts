import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createHandoffArtifact, readHandoffIndex, readLatestHandoffMarkdown } from "../artifacts.js";
import { resolveHandoffPaths } from "../paths.js";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("handoff artifacts", () => {
  it("creates markdown, json, latest, index, and state files", async () => {
    await withTempDir("omb-handoff-artifacts-", async (cwd) => {
      const result = await createHandoffArtifact({ cwd, to: "claude", from: "codebuddy", reason: "handoff", task: "keep going" });
      const paths = resolveHandoffPaths(cwd);
      assert.equal(existsSync(result.record.markdown_path), true);
      assert.equal(existsSync(result.record.json_path), true);
      assert.equal(existsSync(paths.latestMarkdownPath), true);
      assert.equal(existsSync(paths.indexPath), true);
      assert.equal(existsSync(paths.statePath), true);
      assert.match(await readFile(paths.latestMarkdownPath, "utf-8"), /keep going/);
      assert.deepEqual(readHandoffIndex(cwd).map((entry) => entry.id), [result.record.id]);
    });
  });

  it("preserves existing index entries", async () => {
    await withTempDir("omb-handoff-index-", async (cwd) => {
      const first = await createHandoffArtifact({ cwd, to: "claude", from: "codebuddy", task: "one" });
      const second = await createHandoffArtifact({ cwd, to: "codex", from: "claude", task: "two" });
      assert.deepEqual(readHandoffIndex(cwd).map((entry) => entry.id), [first.record.id, second.record.id]);
    });
  });

  it("dry-run writes nothing but returns rendered markdown", async () => {
    await withTempDir("omb-handoff-dry-", async (cwd) => {
      const result = await createHandoffArtifact({ cwd, to: "claude", dryRun: true, task: "preview" });
      assert.match(result.markdown, /preview/);
      assert.equal(existsSync(join(cwd, ".omb")), false);
    });
  });

  it("malformed existing index does not crash", async () => {
    await withTempDir("omb-handoff-bad-index-", async (cwd) => {
      const paths = resolveHandoffPaths(cwd);
      await writeFile(paths.indexPath, "not json", { encoding: "utf-8", flag: "w" }).catch(async () => {
        await import("node:fs/promises").then(({ mkdir }) => mkdir(paths.artifactDir, { recursive: true }));
        await writeFile(paths.indexPath, "not json", "utf-8");
      });
      const result = await createHandoffArtifact({ cwd, to: "claude" });
      assert.deepEqual(readHandoffIndex(cwd).map((entry) => entry.id), [result.record.id]);
      assert.ok(result.warnings.some((warning) => /Malformed handoff index/i.test(warning)));
    });
  });

  it("returns undefined when latest markdown is missing", async () => {
    await withTempDir("omb-handoff-latest-missing-", async (cwd) => {
      assert.equal(readLatestHandoffMarkdown(cwd), undefined);
    });
  });
});
