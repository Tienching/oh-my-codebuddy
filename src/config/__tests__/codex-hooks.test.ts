import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildManagedCodebuddyHooksConfig,
  mergeManagedCodebuddyHooksConfig,
  removeManagedCodebuddyHooks,
} from "../codebuddy-hooks.js";

describe("codebuddy hooks helpers", () => {
  it("merges managed wrappers without dropping user hooks", () => {
    const merged = JSON.parse(
      mergeManagedCodebuddyHooksConfig(
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: "command", command: 'node "/old/dist/scripts/codex-native-hook.js"' },
                  { type: "command", command: "echo keep-me" },
                ],
              },
              {
                hooks: [{ type: "command", command: "echo standalone-user" }],
              },
            ],
          },
        }),
        "/repo",
      ),
    ) as { hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };

    const sessionStart = merged.hooks.SessionStart;
    assert.equal(
      sessionStart.flatMap((entry) => entry.hooks ?? []).filter((hook) =>
        String(hook.command ?? "").includes("codebuddy-native-hook.js")
      ).length,
      1,
    );
    assert.match(JSON.stringify(sessionStart), /echo keep-me/);
    assert.match(JSON.stringify(sessionStart), /echo standalone-user/);
    assert.match(JSON.stringify(sessionStart), /Loading OMB session context/);
    assert.doesNotMatch(JSON.stringify(sessionStart), /codex-native-hook\.js/);
  });

  it("removes both CodeBuddy and legacy Codex managed wrappers during uninstall cleanup", () => {
    const managedOnly = JSON.stringify(buildManagedCodebuddyHooksConfig("/repo"));
    const preserved = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: 'node "/repo/dist/scripts/codebuddy-native-hook.js"' },
              { type: "command", command: 'node "/repo/dist/scripts/codex-native-hook.js"' },
              { type: "command", command: "echo keep-me" },
            ],
          },
        ],
      },
      version: 1,
    });

    const removedManagedOnly = removeManagedCodebuddyHooks(managedOnly);
    assert.equal(removedManagedOnly.removedCount > 0, true);
    assert.equal(removedManagedOnly.nextContent, null);

    const removedMixed = removeManagedCodebuddyHooks(preserved);
    assert.equal(removedMixed.removedCount, 2);
    assert.ok(removedMixed.nextContent);
    assert.match(removedMixed.nextContent, /echo keep-me/);
    assert.doesNotMatch(removedMixed.nextContent, /codebuddy-native-hook\.js/);
    assert.doesNotMatch(removedMixed.nextContent, /codex-native-hook\.js/);
    assert.match(removedMixed.nextContent, /"version": 1/);
  });
});
