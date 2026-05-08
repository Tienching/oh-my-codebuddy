import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createHandoffArtifact } from "../../handoff/artifacts.js";
import { resolveHandoffPaths } from "../../handoff/paths.js";
import { reviewHandoff, resolveHandoffArtifactRef } from "../handoff-review.js";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("handoff review", () => {
  it("approves a structurally complete latest handoff with readiness warnings", async () => {
    await withTempDir("omb-review-valid-", async (cwd) => {
      const created = await createHandoffArtifact({ cwd, to: "claude", from: "codebuddy", task: "continue work" });
      const resolved = resolveHandoffArtifactRef(cwd, "latest");
      assert.equal(resolved.record.id, created.record.id);
      const result = reviewHandoff(resolved);
      assert.equal(result.verdict, "approve");
      assert.ok(result.risks.some((risk) => /verification evidence/i.test(risk)));
      assert.ok(result.checks.some((check) => check.name === "markdown_required_sections" && check.status === "pass"));
    });
  });

  it("resolves a handoff by id or explicit json path", async () => {
    await withTempDir("omb-review-ref-", async (cwd) => {
      const created = await createHandoffArtifact({ cwd, to: "codex", from: "codebuddy" });
      assert.equal(resolveHandoffArtifactRef(cwd, created.record.id).record.id, created.record.id);
      assert.equal(resolveHandoffArtifactRef(cwd, created.record.json_path).record.id, created.record.id);
    });
  });

  it("rejects malformed provider and markdown shape", async () => {
    await withTempDir("omb-review-bad-", async (cwd) => {
      const paths = resolveHandoffPaths(cwd);
      await mkdir(paths.artifactDir, { recursive: true });
      const jsonPath = paths.jsonPathFor("handoff-bad");
      const markdownPath = paths.markdownPathFor("handoff-bad");
      await writeFile(markdownPath, "# Not a handoff\n", "utf-8");
      await writeFile(jsonPath, JSON.stringify({
        record: {
          id: "handoff-bad",
          from_provider: "codebuddy",
          to_provider: "openai",
          cwd,
          mode: "unknown",
          markdown_path: markdownPath,
          json_path: jsonPath,
          created_at: new Date().toISOString(),
          status: "created",
        },
        context: { cwd, project_name: "x", changed_files: [], active_modes: [], plan_files: [], warnings: [] },
      }), "utf-8");
      const result = reviewHandoff(resolveHandoffArtifactRef(cwd, jsonPath));
      assert.equal(result.verdict, "reject");
      assert.ok(result.required_fixes.some((fix) => /provider/i.test(fix)));
      assert.ok(result.required_fixes.some((fix) => /markdown/i.test(fix)));
    });
  });

  it("fails clearly when latest handoff is missing", async () => {
    await withTempDir("omb-review-missing-", async (cwd) => {
      assert.throws(() => resolveHandoffArtifactRef(cwd, "latest"), /No latest handoff found/);
    });
  });
});
