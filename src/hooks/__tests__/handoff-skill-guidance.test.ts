import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const handoffSkill = readFileSync(join(process.cwd(), 'skills', 'handoff', 'SKILL.md'), 'utf-8');

describe('handoff skill guidance', () => {
  it('documents artifact creation, review, safe launch, and old-session stop semantics', () => {
    assert.match(handoffSkill, /omb handoff --to <provider> --from <current-provider> --mode <current-mode>/);
    assert.match(handoffSkill, /omb review --handoff latest --with <provider>/);
    assert.match(handoffSkill, /omb switch --to <provider> --handoff latest --launch/);
    assert.match(handoffSkill, /NEW tmux-backed OMB session/);
    assert.match(handoffSkill, /Do not describe it as a hot-swap/);
    assert.match(handoffSkill, /I will stop editing in this session now/);
  });
});
