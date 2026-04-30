import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as codebuddyHookModule from "../codebuddy-native-hook.js";
import * as claudeHookModule from "../claude-native-hook.js";
import { buildManagedClaudeHooksConfig } from "../../config/codebuddy-hooks.js";

const CANONICAL_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;

describe("claude-native-hook provider parity", () => {
  it("re-exports the CodeBuddy native-hook implementation", () => {
    for (const name of Object.keys(codebuddyHookModule)) {
      assert.ok(
        name in claudeHookModule,
        `claude-native-hook missing re-exported symbol: ${name}`,
      );
    }
  });

  it("uses the Claude-specific hook entry script for all canonical events", () => {
    const config = buildManagedClaudeHooksConfig("/tmp/omb-pkg-root");
    const serialized = JSON.stringify(config);

    for (const event of CANONICAL_EVENTS) {
      assert.ok(config.hooks[event], `${event} hook should be present`);
    }
    assert.match(serialized, /claude-native-hook\.js/);
    assert.doesNotMatch(serialized, /codebuddy-native-hook\.js/);
    assert.doesNotMatch(serialized, /codex-native-hook\.js/);
  });
});
