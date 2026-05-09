import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const switchSkill = readFileSync(join(process.cwd(), 'skills', 'switch', 'SKILL.md'), 'utf-8');

describe('switch skill guidance', () => {
  it('documents artifact creation, review, safe launch, and old-session stop semantics', () => {
    assert.match(switchSkill, /\$switch <provider>/);
    assert.match(switchSkill, /omb handoff --to <provider> --from <current-provider> --mode <current-mode>/);
    assert.match(switchSkill, /omb review --handoff latest --with <provider>/);
    assert.match(switchSkill, /omb switch --to <provider> --handoff latest --launch/);
    assert.match(switchSkill, /NEW tmux-backed OMB session/);
    assert.match(switchSkill, /Do not describe it as a hot-swap/);
    assert.match(switchSkill, /I will stop editing in this session now/);
  });
});
