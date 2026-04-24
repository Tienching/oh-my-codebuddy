import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectKeywords,
  detectPrimaryKeyword,
  getAllKeywordsWithSizeCheck,
  isExperimentalMagicKeywordRouterEnabled,
} from '../magic-keywords.js';

describe('magic-keywords', () => {
  it('keeps explicit skill invocation order left-to-right', () => {
    const matches = detectKeywords('$analyze $ultraqa $code-review now');
    assert.deepEqual(matches.map((match) => match.skill), ['analyze', 'ultraqa', 'code-review']);
  });

  it('does not trigger team routing from incidental prose or team-state paths', () => {
    assert.equal(detectPrimaryKeyword('the team reviewed the document and shared feedback'), null);
    assert.equal(
      detectPrimaryKeyword('Read .omb/state/team/execute-plan/mailbox/worker-3.json and continue assigned work.'),
      null,
    );
  });

  it('prefers the longest matching alias when priorities are equal', () => {
    const match = detectPrimaryKeyword('please run a coordinated swarm for implementation');
    assert.ok(match);
    assert.equal(match.skill, 'team');
    assert.equal(match.keyword.toLowerCase(), 'coordinated swarm');
  });

  it('suppresses heavy orchestration keywords for small tasks in size-aware mode', () => {
    const result = getAllKeywordsWithSizeCheck('quick: use team to fix typo in README');
    assert.deepEqual(result.keywords, []);
    assert.deepEqual(result.suppressedKeywords, ['team']);
    assert.equal(result.taskSizeResult?.size, 'small');
  });

  it('reads the experimental router flag from env aliases', () => {
    assert.equal(isExperimentalMagicKeywordRouterEnabled({ OMB_MAGIC_KEYWORD_ROUTER: '1' } as NodeJS.ProcessEnv), true);
    assert.equal(isExperimentalMagicKeywordRouterEnabled({ OMB_MAGIC_KEYWORD_ROUTER: 'true' } as NodeJS.ProcessEnv), true);
    assert.equal(isExperimentalMagicKeywordRouterEnabled({} as NodeJS.ProcessEnv), false);
  });
});
