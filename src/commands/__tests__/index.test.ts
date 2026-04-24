import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  expandCommandPrompt,
  getCommandInfo,
  listCommandNames,
  isCommandTemplateEnabled,
} from "../index.js";

describe("isCommandTemplateEnabled", () => {
  it("is off by default", () => {
    assert.equal(isCommandTemplateEnabled({}), false);
  });

  it("enables when explicit on flag is set", () => {
    assert.equal(isCommandTemplateEnabled({
      OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "1",
    }), true);
  });

  it("disables when explicit off value is set", () => {
    assert.equal(isCommandTemplateEnabled({
      OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "off",
    }), false);
  });
});

describe("command template resolution", () => {
  it("loads from .codebuddy and falls back to legacy .codex", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-command-template-"));
    try {
      const primaryDir = join(cwd, ".codebuddy", "commands");
      const legacyDir = join(cwd, ".codex", "commands");
      await mkdir(primaryDir, { recursive: true });
      await mkdir(legacyDir, { recursive: true });

      await writeFile(
        join(primaryDir, "deploy.md"),
        ['---', 'description: "primary"', "---", "primary command"].join("\n"),
      );
      await writeFile(
        join(legacyDir, "legacy.md"),
        ['---', 'description: "legacy"', "---", "legacy command"].join("\n"),
      );

      const names = await listCommandNames({
        cwd,
        env: {
          CODEBUDDY_HOME: join(cwd, ".codebuddy-home"),
          CODEX_HOME: join(cwd, ".legacy-home"),
        },
      });
      assert.deepEqual(names, ["deploy", "legacy"]);

      const prompt = await expandCommandPrompt(
        "deploy",
        [],
        {
          cwd,
          env: { OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "1" },
        },
      );
      assert.equal(prompt, "primary command");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to legacy user home root when needed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-command-template-home-"));
    const legacyHome = await mkdtemp(join(tmpdir(), "omb-codex-legacy-"));
    const codebuddyHome = await mkdtemp(join(tmpdir(), "omb-codebuddy-home-"));
    try {
      const legacyDir = join(legacyHome, ".codex", "commands");
      const projectDir = join(cwd, ".codebuddy", "commands");
      await mkdir(legacyDir, { recursive: true });
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(legacyDir, "legacy.md"),
        ['---', 'description: "user legacy"', "---", "legacy prompt"].join("\n"),
      );

      const info = await getCommandInfo("legacy", {
        cwd,
        env: {
          CODEBUDDY_HOME: codebuddyHome,
          CODEX_HOME: legacyHome,
          OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "1",
        },
      });
      assert.equal(info?.description, "user legacy");
      assert.equal(info?.template, "legacy prompt");
      const prompt = await expandCommandPrompt(
        "legacy",
        ["with", "args"],
        {
          cwd,
          env: {
            CODEBUDDY_HOME: codebuddyHome,
            CODEX_HOME: legacyHome,
            OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "1",
          },
        },
      );
      assert.equal(prompt, "legacy prompt");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(legacyHome, { recursive: true, force: true });
      await rm(codebuddyHome, { recursive: true, force: true });
    }
  });

  it("rejects invalid command names as command-template lookups", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-command-template-invalid-"));
    try {
      const prompt = await expandCommandPrompt(
        "../bad",
        ["x"],
        {
          cwd,
          env: { OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "1" },
        },
      );
      assert.equal(prompt, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
