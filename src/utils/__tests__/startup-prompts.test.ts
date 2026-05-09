import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paneHasClaudeBypassPermissionsPrompt, paneHasWorkspaceTrustPrompt } from "../startup-prompts.js";

describe("startup prompt detection", () => {
  it("detects the legacy trust prompt wording", () => {
    const captured = [
      "Do you trust the contents of this directory?",
      "Press enter to continue",
    ].join("\n");

    assert.equal(paneHasWorkspaceTrustPrompt(captured), true);
  });

  it("detects the Claude Code Internal trust prompt wording", () => {
    const captured = [
      "Quick safety check: Is this a project you created or one you trust?",
      "❯ 1. Yes, I trust this folder",
      "2. No, exit",
      "Enter to confirm · Esc to cancel",
    ].join("\n");

    assert.equal(paneHasWorkspaceTrustPrompt(captured), true);
  });

  it("does not false-positive on unrelated safety text", () => {
    const captured = [
      "Quick safety check before release",
      "This folder contains generated files.",
    ].join("\n");

    assert.equal(paneHasWorkspaceTrustPrompt(captured), false);
  });

  it("detects the Claude bypass permissions prompt", () => {
    const captured = [
      "Bypass Permissions mode lets Claude run tools without confirmation.",
      "1. No, exit",
      "2. Yes, I accept",
      "Enter to confirm",
    ].join("\n");

    assert.equal(paneHasClaudeBypassPermissionsPrompt(captured), true);
  });
});
