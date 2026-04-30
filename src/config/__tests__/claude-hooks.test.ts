import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildManagedClaudeHooksConfig,
  mergeManagedClaudeHooksConfig,
} from "../codebuddy-hooks.js";

const CANONICAL_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;

describe("Claude managed hooks config", () => {
  it("returns a stable five-event hooks.json shape", () => {
    const first = buildManagedClaudeHooksConfig("/repo");
    const second = buildManagedClaudeHooksConfig("/repo");

    assert.deepEqual(first, second);
    assert.deepEqual(Object.keys(first.hooks).sort(), [...CANONICAL_EVENTS].sort());
    for (const event of CANONICAL_EVENTS) {
      const entries = first.hooks[event];
      assert.equal(entries.length, 1);
      assert.ok(Array.isArray(entries[0]?.hooks));
      assert.match(JSON.stringify(entries), /claude-native-hook\.js/);
    }
  });

  it("merges without duplicating stale managed wrappers or dropping user hooks", () => {
    const merged = JSON.parse(
      mergeManagedClaudeHooksConfig(
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: "command", command: 'node "/old/dist/scripts/claude-native-hook.js"' },
                  { type: "command", command: "echo keep-me" },
                ],
              },
            ],
          },
          version: 1,
        }),
        "/repo",
      ),
    ) as { hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>; version?: number };

    const sessionStartCommands = merged.hooks.SessionStart.flatMap((entry) =>
      entry.hooks ?? []
    ).map((hook) => hook.command ?? "");
    assert.equal(
      sessionStartCommands.filter((command) => command.includes("claude-native-hook.js")).length,
      1,
    );
    assert.match(JSON.stringify(merged), /echo keep-me/);
    assert.equal(merged.version, 1);
  });
});
