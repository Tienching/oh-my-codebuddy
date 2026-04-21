import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../../../');

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf-8');
}

function extract(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker ${endMarker}`);
  return text.slice(start + startMarker.length, end).trim();
}

describe('prompt-guidance fragments stay synced with generated surfaces', () => {
  it('syncs root/template AGENTS shared guidance blocks', () => {
    const operating = read('docs/prompt-guidance-fragments/core-operating-principles.md').trim();
    const verifySeq = read('docs/prompt-guidance-fragments/core-verification-and-sequencing.md').trim();

    for (const file of ['AGENTS.md', 'templates/AGENTS.md']) {
      const content = read(file);
      assert.equal(
        extract(content, '<!-- OMB:GUIDANCE:OPERATING:START -->', '<!-- OMB:GUIDANCE:OPERATING:END -->'),
        operating,
      );
      assert.equal(
        extract(content, '<!-- OMB:GUIDANCE:VERIFYSEQ:START -->', '<!-- OMB:GUIDANCE:VERIFYSEQ:END -->'),
        verifySeq,
      );
    }
  });

  it('syncs executor guidance fragments', () => {
    const content = read('prompts/executor.md');
    assert.equal(
      extract(content, '<!-- OMB:GUIDANCE:EXECUTOR:CONSTRAINTS:START -->', '<!-- OMB:GUIDANCE:EXECUTOR:CONSTRAINTS:END -->'),
      read('docs/prompt-guidance-fragments/executor-constraints.md').trim(),
    );
    assert.equal(
      extract(content, '<!-- OMB:GUIDANCE:EXECUTOR:OUTPUT:START -->', '<!-- OMB:GUIDANCE:EXECUTOR:OUTPUT:END -->'),
      read('docs/prompt-guidance-fragments/executor-output.md').trim(),
    );
  });

  it('syncs planner guidance fragments', () => {
    const content = read('prompts/planner.md');
    assert.equal(
      extract(content, '<!-- OMB:GUIDANCE:PLANNER:CONSTRAINTS:START -->', '<!-- OMB:GUIDANCE:PLANNER:CONSTRAINTS:END -->'),
      read('docs/prompt-guidance-fragments/planner-constraints.md').trim(),
    );
    assert.equal(
      extract(content, '<!-- OMB:GUIDANCE:PLANNER:INVESTIGATION:START -->', '<!-- OMB:GUIDANCE:PLANNER:INVESTIGATION:END -->'),
      read('docs/prompt-guidance-fragments/planner-investigation.md').trim(),
    );
    assert.equal(
      extract(content, '<!-- OMB:GUIDANCE:PLANNER:OUTPUT:START -->', '<!-- OMB:GUIDANCE:PLANNER:OUTPUT:END -->'),
      read('docs/prompt-guidance-fragments/planner-output.md').trim(),
    );
  });

  it('syncs verifier guidance fragments', () => {
    const content = read('prompts/verifier.md');
    assert.equal(
      extract(content, '<!-- OMB:GUIDANCE:VERIFIER:CONSTRAINTS:START -->', '<!-- OMB:GUIDANCE:VERIFIER:CONSTRAINTS:END -->'),
      read('docs/prompt-guidance-fragments/verifier-constraints.md').trim(),
    );
    assert.equal(
      extract(content, '<!-- OMB:GUIDANCE:VERIFIER:INVESTIGATION:START -->', '<!-- OMB:GUIDANCE:VERIFIER:INVESTIGATION:END -->'),
      read('docs/prompt-guidance-fragments/verifier-investigation.md').trim(),
    );
  });
});
