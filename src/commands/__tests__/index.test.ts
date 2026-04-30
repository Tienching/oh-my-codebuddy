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
  it("loads from project .codebuddy commands only by default", async () => {
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
      assert.deepEqual(names, ["deploy"]);

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

  it("loads from CODEBUDDY_HOME and ignores CODEX_HOME", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-command-template-home-"));
    const legacyHome = await mkdtemp(join(tmpdir(), "omb-codex-legacy-"));
    const codebuddyHome = await mkdtemp(join(tmpdir(), "omb-codebuddy-home-"));
    try {
      const legacyDir = join(legacyHome, ".codex", "commands");
      const codebuddyDir = join(codebuddyHome, "commands");
      await mkdir(legacyDir, { recursive: true });
      await mkdir(codebuddyDir, { recursive: true });
      await writeFile(
        join(legacyDir, "legacy.md"),
        ['---', 'description: "user legacy"', "---", "legacy prompt"].join("\n"),
      );
      await writeFile(
        join(codebuddyDir, "buddy.md"),
        ['---', 'description: "user codebuddy"', "---", "buddy prompt"].join("\n"),
      );

      const info = await getCommandInfo("buddy", {
        cwd,
        env: {
          CODEBUDDY_HOME: codebuddyHome,
          CODEX_HOME: legacyHome,
          OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "1",
        },
      });
      assert.equal(info?.description, "user codebuddy");
      assert.equal(info?.template, "buddy prompt");
      assert.equal(
        await getCommandInfo("legacy", {
          cwd,
          env: {
            CODEBUDDY_HOME: codebuddyHome,
            CODEX_HOME: legacyHome,
            OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "1",
          },
        }),
        undefined,
      );
      const prompt = await expandCommandPrompt(
        "buddy",
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
      assert.equal(prompt, "buddy prompt");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(legacyHome, { recursive: true, force: true });
      await rm(codebuddyHome, { recursive: true, force: true });
    }
  });

  it("loads command templates from .codex/commands and CODEX_HOME when setup provider=codex", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-command-template-codex-"));
    const codebuddyHome = await mkdtemp(join(tmpdir(), "omb-codebuddy-home-"));
    const codexHome = await mkdtemp(join(tmpdir(), "omb-codex-home-"));
    try {
      const projectCodexDir = join(cwd, ".codex", "commands");
      const projectCodebuddyDir = join(cwd, ".codebuddy", "commands");
      const homeCodexDir = join(codexHome, "commands");
      const homeCodebuddyDir = join(codebuddyHome, "commands");
      await mkdir(projectCodexDir, { recursive: true });
      await mkdir(projectCodebuddyDir, { recursive: true });
      await mkdir(homeCodexDir, { recursive: true });
      await mkdir(homeCodebuddyDir, { recursive: true });
      await writeFile(
        join(projectCodexDir, "project.md"),
        ['---', 'description: "project codex"', "---", "project codex command"].join("\n"),
      );
      await writeFile(
        join(homeCodexDir, "home.md"),
        ['---', 'description: "home codex"', "---", "home codex command"].join("\n"),
      );
      await writeFile(
        join(projectCodebuddyDir, "buddy.md"),
        ['---', 'description: "project buddy"', "---", "should not use codebuddy for codex setup"].join("\n"),
      );
      await writeFile(
        join(homeCodebuddyDir, "home-buddy.md"),
        ['---', 'description: "home buddy"', "---", "should not use codebuddy for codex setup"].join("\n"),
      );
      await mkdir(join(cwd, ".omb"), { recursive: true });
      await writeFile(
        join(cwd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project", provider: "codex" }),
      );

      const names = await listCommandNames({
        cwd,
        env: {
          CODEBUDDY_HOME: codebuddyHome,
          CODEX_HOME: codexHome,
        },
      });
      assert.deepEqual(names.sort(), ["home", "project"]);

      const projectInfo = await getCommandInfo("project", {
        cwd,
        env: {
          CODEBUDDY_HOME: codebuddyHome,
          CODEX_HOME: codexHome,
          OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "1",
        },
      });
      assert.equal(projectInfo?.description, "project codex");
      assert.equal(projectInfo?.template, "project codex command");
      const homeInfo = await getCommandInfo("home", {
        cwd,
        env: {
          CODEBUDDY_HOME: codebuddyHome,
          CODEX_HOME: codexHome,
          OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "1",
        },
      });
      assert.equal(homeInfo?.description, "home codex");
      assert.equal(homeInfo?.template, "home codex command");
      assert.equal(
        await getCommandInfo("buddy", {
          cwd,
          env: {
            CODEBUDDY_HOME: codebuddyHome,
            CODEX_HOME: codexHome,
            OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "1",
          },
        }),
        undefined,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(codebuddyHome, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("loads command templates from .claude/commands and CLAUDE_HOME when setup provider=claude", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-command-template-claude-"));
    const codebuddyHome = await mkdtemp(join(tmpdir(), "omb-codebuddy-home-"));
    const codexHome = await mkdtemp(join(tmpdir(), "omb-codex-home-"));
    const claudeHome = await mkdtemp(join(tmpdir(), "omb-claude-home-"));
    try {
      const projectClaudeDir = join(cwd, ".claude", "commands");
      const projectCodebuddyDir = join(cwd, ".codebuddy", "commands");
      const projectCodexDir = join(cwd, ".codex", "commands");
      const homeClaudeDir = join(claudeHome, "commands");
      await mkdir(projectClaudeDir, { recursive: true });
      await mkdir(projectCodebuddyDir, { recursive: true });
      await mkdir(projectCodexDir, { recursive: true });
      await mkdir(homeClaudeDir, { recursive: true });
      await writeFile(
        join(projectClaudeDir, "project.md"),
        ['---', 'description: "project claude"', "---", "project claude command"].join("\n"),
      );
      await writeFile(
        join(homeClaudeDir, "home.md"),
        ['---', 'description: "home claude"', "---", "home claude command"].join("\n"),
      );
      await writeFile(
        join(projectCodebuddyDir, "buddy.md"),
        ['---', 'description: "project buddy"', "---", "should not use codebuddy for claude setup"].join("\n"),
      );
      await writeFile(
        join(projectCodexDir, "codex.md"),
        ['---', 'description: "project codex"', "---", "should not use codex for claude setup"].join("\n"),
      );
      await mkdir(join(cwd, ".omb"), { recursive: true });
      await writeFile(
        join(cwd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project", provider: "claude" }),
      );

      const names = await listCommandNames({
        cwd,
        env: {
          CODEBUDDY_HOME: codebuddyHome,
          CODEX_HOME: codexHome,
          CLAUDE_HOME: claudeHome,
        },
      });
      assert.deepEqual(names.sort(), ["home", "project"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(codebuddyHome, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
      await rm(claudeHome, { recursive: true, force: true });
    }
  });

  it("loads command templates from both providers when setup provider=both", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-command-template-both-"));
    const codebuddyHome = await mkdtemp(join(tmpdir(), "omb-codebuddy-home-both-"));
    const codexHome = await mkdtemp(join(tmpdir(), "omb-codex-home-both-"));
    try {
      const projectCodexDir = join(cwd, ".codex", "commands");
      const projectCodebuddyDir = join(cwd, ".codebuddy", "commands");
      const homeCodexDir = join(codexHome, "commands");
      const homeCodebuddyDir = join(codebuddyHome, "commands");
      await mkdir(projectCodexDir, { recursive: true });
      await mkdir(projectCodebuddyDir, { recursive: true });
      await mkdir(homeCodexDir, { recursive: true });
      await mkdir(homeCodebuddyDir, { recursive: true });
      await writeFile(
        join(projectCodexDir, "shared.md"),
        ['---', 'description: "project codex"', "---", "shared from project codex"].join("\n"),
      );
      await writeFile(
        join(projectCodebuddyDir, "local.md"),
        ['---', 'description: "project buddy"', "---", "project buddy local"].join("\n"),
      );
      await writeFile(
        join(homeCodexDir, "home-codex.md"),
        ['---', 'description: "home codex"', "---", "home codex"].join("\n"),
      );
      await writeFile(
        join(homeCodebuddyDir, "home-buddy.md"),
        ['---', 'description: "home buddy"', "---", "home buddy"].join("\n"),
      );
      await mkdir(join(cwd, ".omb"), { recursive: true });
      await writeFile(
        join(cwd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project", provider: "both" }),
      );

      const names = await listCommandNames({
        cwd,
        env: {
          CODEBUDDY_HOME: codebuddyHome,
          CODEX_HOME: codexHome,
        },
      });
      assert.deepEqual(names.sort(), ["home-buddy", "home-codex", "local", "shared"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(codebuddyHome, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("loads command templates from all providers when setup provider=all", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omb-command-template-all-"));
    const codebuddyHome = await mkdtemp(join(tmpdir(), "omb-codebuddy-home-all-"));
    const codexHome = await mkdtemp(join(tmpdir(), "omb-codex-home-all-"));
    const claudeHome = await mkdtemp(join(tmpdir(), "omb-claude-home-all-"));
    try {
      for (const dir of [
        join(cwd, ".codebuddy", "commands"),
        join(cwd, ".codex", "commands"),
        join(cwd, ".claude", "commands"),
        join(codebuddyHome, "commands"),
        join(codexHome, "commands"),
        join(claudeHome, "commands"),
      ]) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(join(cwd, ".codebuddy", "commands", "project-buddy.md"), "---\ndescription: project buddy\n---\nproject buddy\n");
      await writeFile(join(cwd, ".codex", "commands", "project-codex.md"), "---\ndescription: project codex\n---\nproject codex\n");
      await writeFile(join(cwd, ".claude", "commands", "project-claude.md"), "---\ndescription: project claude\n---\nproject claude\n");
      await writeFile(join(codebuddyHome, "commands", "home-buddy.md"), "---\ndescription: home buddy\n---\nhome buddy\n");
      await writeFile(join(codexHome, "commands", "home-codex.md"), "---\ndescription: home codex\n---\nhome codex\n");
      await writeFile(join(claudeHome, "commands", "home-claude.md"), "---\ndescription: home claude\n---\nhome claude\n");
      await mkdir(join(cwd, ".omb"), { recursive: true });
      await writeFile(
        join(cwd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project", provider: "all" }),
      );

      const names = await listCommandNames({
        cwd,
        env: {
          CODEBUDDY_HOME: codebuddyHome,
          CODEX_HOME: codexHome,
          CLAUDE_HOME: claudeHome,
        },
      });
      assert.deepEqual(
        names.sort(),
        ["home-buddy", "home-claude", "home-codex", "project-buddy", "project-claude", "project-codex"],
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(codebuddyHome, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
      await rm(claudeHome, { recursive: true, force: true });
    }
  });

  it("prefers project scope over user scope across providers when setup provider=both", async () => {
    // Regression guard for provider=both ordering. A same-named template
    // installed in a project's .codex/commands must win over an ambient
    // CodeBuddy user home, so a per-project Codex override isn't shadowed by
    // whichever provider happens to be installed globally.
    const cwd = await mkdtemp(join(tmpdir(), "omb-command-template-both-order-"));
    const codebuddyHome = await mkdtemp(join(tmpdir(), "omb-codebuddy-home-both-order-"));
    const codexHome = await mkdtemp(join(tmpdir(), "omb-codex-home-both-order-"));
    try {
      const projectCodexDir = join(cwd, ".codex", "commands");
      const homeCodebuddyDir = join(codebuddyHome, "commands");
      await mkdir(projectCodexDir, { recursive: true });
      await mkdir(homeCodebuddyDir, { recursive: true });
      await writeFile(
        join(projectCodexDir, "shared.md"),
        ['---', 'description: "project codex wins"', "---", "project codex content"].join("\n"),
      );
      await writeFile(
        join(homeCodebuddyDir, "shared.md"),
        ['---', 'description: "user codebuddy loses"', "---", "user codebuddy content"].join("\n"),
      );
      await mkdir(join(cwd, ".omb"), { recursive: true });
      await writeFile(
        join(cwd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "project", provider: "both" }),
      );

      const prompt = await expandCommandPrompt(
        "shared",
        [],
        {
          cwd,
          env: {
            OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "1",
            CODEBUDDY_HOME: codebuddyHome,
            CODEX_HOME: codexHome,
          },
        },
      );
      assert.ok(prompt, "expected shared command template to resolve");
      assert.match(prompt!, /project codex content/);
      assert.doesNotMatch(prompt!, /user codebuddy content/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(codebuddyHome, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("warns and falls back to codebuddy when setup-scope provider is invalid", async () => {
    // A hand-edited or upgraded setup-scope.json with an unknown provider
    // value must not silently collapse to CodeBuddy; emit a stderr warning
    // so the situation is visible, then still resolve CodeBuddy templates so
    // users can recover without a hard failure.
    const cwd = await mkdtemp(join(tmpdir(), "omb-command-template-invalid-provider-"));
    const codebuddyHome = await mkdtemp(join(tmpdir(), "omb-codebuddy-home-invalid-"));
    try {
      const homeCodebuddyDir = join(codebuddyHome, "commands");
      await mkdir(homeCodebuddyDir, { recursive: true });
      await writeFile(
        join(homeCodebuddyDir, "warn-fallback.md"),
        ['---', 'description: "fallback"', "---", "fallback content"].join("\n"),
      );
      await mkdir(join(cwd, ".omb"), { recursive: true });
      await writeFile(
        join(cwd, ".omb", "setup-scope.json"),
        JSON.stringify({ scope: "user", provider: "gemini" }),
      );

      const stderrWrites: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
        return true;
      }) as typeof process.stderr.write;
      try {
        const prompt = await expandCommandPrompt(
          "warn-fallback",
          [],
          {
            cwd,
            env: {
              OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "1",
              CODEBUDDY_HOME: codebuddyHome,
            },
          },
        );
        assert.ok(prompt, "expected fallback command to resolve after warning");
        assert.match(prompt!, /fallback content/);
      } finally {
        process.stderr.write = originalWrite;
      }
      const warnings = stderrWrites.join("");
      assert.match(warnings, /unknown provider "gemini"/);
      assert.match(warnings, /falling back to codebuddy/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
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
