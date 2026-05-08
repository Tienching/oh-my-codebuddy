import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderHandoffArtifact } from "../render.js";
import type { HandoffArtifactRecord } from "../contract.js";
import type { HandoffContext } from "../context.js";

const record: HandoffArtifactRecord = {
  id: "handoff-20260505-010203-abc123",
  from_provider: "codebuddy",
  to_provider: "claude",
  cwd: "/tmp/project",
  mode: "autopilot",
  reason: "test repair",
  task: "continue webhook work",
  markdown_path: "/tmp/project/.omb/handoffs/handoff-20260505-010203-abc123.md",
  json_path: "/tmp/project/.omb/handoffs/handoff-20260505-010203-abc123.json",
  created_at: "2026-05-05T01:02:03.000Z",
  status: "created",
};

const context: HandoffContext = {
  cwd: "/tmp/project",
  project_name: "project",
  branch: "main",
  git_status: "## main\n M src/app.ts",
  changed_files: ["src/app.ts"],
  diff_summary: " src/app.ts | 2 ++",
  session: { session_id: "s1" },
  active_modes: ["autopilot"],
  plan_files: ["autopilot-impl.md"],
  warnings: ["git diff truncated"],
};

describe("renderHandoffArtifact", () => {
  it("renders handoff metadata, task, warnings, and changed files", () => {
    const markdown = renderHandoffArtifact(record, context);
    assert.match(markdown, /# OMB Provider Handoff/);
    assert.match(markdown, /- From: codebuddy/);
    assert.match(markdown, /- To: claude/);
    assert.match(markdown, /- Reason: test repair/);
    assert.match(markdown, /continue webhook work/);
    assert.match(markdown, /src\/app\.ts/);
    assert.match(markdown, /git diff truncated/);
    assert.match(markdown, /omb --leader-cli claude/);
  });

  it("suggests review instead of leader launch for gemini", () => {
    const markdown = renderHandoffArtifact({ ...record, to_provider: "gemini" }, context);
    assert.match(markdown, /omb review --with gemini --handoff latest/);
    assert.doesNotMatch(markdown, /--leader-cli gemini/);
  });

  it("does not include full diffs", () => {
    const markdown = renderHandoffArtifact(record, { ...context, diff_summary: "diff --git a/x b/x\n+secret" });
    assert.doesNotMatch(markdown, /diff --git a\//);
  });
});
