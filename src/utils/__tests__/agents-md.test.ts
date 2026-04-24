import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addGeneratedAgentsMarker, isOmbGeneratedAgentsMd, OMB_GENERATED_AGENTS_MARKER } from '../agents-md.js';

describe('agents-md helpers', () => {
  it('inserts the generated marker after the autonomy directive block', () => {
    const content = [
      '<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->',
      'YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.',
      'DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.',
      'IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.',
      '<!-- END AUTONOMY DIRECTIVE -->',
      '# oh-my-codebuddy - Intelligent Multi-Agent Orchestration',
    ].join('\n');

    const result = addGeneratedAgentsMarker(content);

    assert.match(
      result,
      /<!-- END AUTONOMY DIRECTIVE -->\n<!-- omb:generated:agents-md -->\n# oh-my-codebuddy - Intelligent Multi-Agent Orchestration/,
    );
  });

  it('does not duplicate an existing generated marker', () => {
    const content = `header\n${OMB_GENERATED_AGENTS_MARKER}\nbody\n`;
    assert.equal(addGeneratedAgentsMarker(content), content);
  });

  it('treats autonomy-directive generated files as OMB-managed once marked', () => {
    const content = [
      '<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->',
      'directive body',
      '<!-- END AUTONOMY DIRECTIVE -->',
      OMB_GENERATED_AGENTS_MARKER,
      '# oh-my-codebuddy - Intelligent Multi-Agent Orchestration',
    ].join('\n');

    assert.equal(isOmbGeneratedAgentsMd(content), true);
  });
});
