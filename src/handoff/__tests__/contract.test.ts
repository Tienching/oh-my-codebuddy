import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHandoffId, HANDOFF_PROVIDERS, parseHandoffProvider } from "../contract.js";

describe("handoff contract", () => {
  it("parses valid providers", () => {
    for (const provider of HANDOFF_PROVIDERS) {
      assert.equal(parseHandoffProvider(provider), provider);
    }
  });

  it("rejects invalid providers with valid choices", () => {
    assert.throws(
      () => parseHandoffProvider("openai", "--to"),
      /Invalid --to provider "openai"\. Expected one of: codebuddy, codex, claude, gemini/,
    );
  });

  it("builds stable-shaped handoff ids", () => {
    const id = buildHandoffId(new Date("2026-05-05T01:02:03.000Z"));
    assert.match(id, /^handoff-20260505-010203-[a-z0-9]{6}$/);
  });
});
