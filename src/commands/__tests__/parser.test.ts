import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCommandFile } from "../parser.js";

describe("parseCommandFile", () => {
  it("returns full content when front matter is missing", () => {
    const content = "say hello $ARGUMENTS";
    const parsed = parseCommandFile(content);
    assert.equal(parsed.description, "");
    assert.equal(parsed.template, content);
  });

  it("parses description and template from front matter", () => {
    const parsed = parseCommandFile(
      [
        "---",
        'description: "run tests"',
        "---",
        "npm test $ARGUMENTS",
      ].join("\n"),
    );
    assert.equal(parsed.description, "run tests");
    assert.equal(parsed.template, "npm test $ARGUMENTS");
  });

  it("keeps front matter parser resilient when closing marker is malformed", () => {
    const content = [
      "---",
      'description: "bad command"',
      "template: npm test",
    ].join("\n");
    const parsed = parseCommandFile(content);
    assert.equal(parsed.description, "");
    assert.equal(parsed.template, content);
  });
});
