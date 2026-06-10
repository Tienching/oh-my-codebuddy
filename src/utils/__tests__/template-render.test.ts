import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getTemplateReplacements, renderTemplate, TEMPLATE_PLACEHOLDERS } from '../template-render.js';

describe('template-render', () => {
  describe('getTemplateReplacements', () => {
    it('user+codebuddy maps all placeholders to ~/.codebuddy', () => {
      const r = getTemplateReplacements('user', 'codebuddy');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CODEBUDDY_HOME), '~/.codebuddy');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CODEX_HOME), '~/.codebuddy');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CLAUDE_HOME), '~/.codebuddy');
    });

    it('user+codex maps all placeholders to ~/.codex', () => {
      const r = getTemplateReplacements('user', 'codex');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CODEX_HOME), '~/.codex');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CODEBUDDY_HOME), '~/.codex');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CLAUDE_HOME), '~/.codex');
    });

    it('user+claude maps all placeholders to ~/.claude', () => {
      const r = getTemplateReplacements('user', 'claude');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CLAUDE_HOME), '~/.claude');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CODEBUDDY_HOME), '~/.claude');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CODEX_HOME), '~/.claude');
    });

    it('project+codebuddy uses ./.codebuddy', () => {
      const r = getTemplateReplacements('project', 'codebuddy');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CODEBUDDY_HOME), './.codebuddy');
    });

    it('user+both keeps codebuddy and codex separate', () => {
      const r = getTemplateReplacements('user', 'both');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CODEBUDDY_HOME), '~/.codebuddy');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CODEX_HOME), '~/.codex');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CLAUDE_HOME), undefined);
    });

    it('project+all keeps all three separate', () => {
      const r = getTemplateReplacements('project', 'all');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CODEBUDDY_HOME), './.codebuddy');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CODEX_HOME), './.codex');
      assert.equal(r.get(TEMPLATE_PLACEHOLDERS.CLAUDE_HOME), './.claude');
    });
  });

  describe('renderTemplate', () => {
    it('replaces placeholders but not plain text', () => {
      const content = 'Skills: {{CODEX_HOME}}/skills -- example: ~/.codex/skills';
      const r = new Map([[TEMPLATE_PLACEHOLDERS.CODEX_HOME, '~/.codex']]);
      assert.equal(renderTemplate(content, r), 'Skills: ~/.codex/skills -- example: ~/.codex/skills');
    });

    it('replaces multiple placeholders', () => {
      const content = 'Home: {{CODEBUDDY_HOME}}, Skills: {{CODEX_HOME}}/skills';
      const r = new Map([
        [TEMPLATE_PLACEHOLDERS.CODEBUDDY_HOME, '~/.codebuddy'],
        [TEMPLATE_PLACEHOLDERS.CODEX_HOME, '~/.codex'],
      ]);
      assert.equal(renderTemplate(content, r), 'Home: ~/.codebuddy, Skills: ~/.codex/skills');
    });

    it('leaves unreferenced placeholders unchanged', () => {
      const content = '{{CLAUDE_HOME}} not set';
      const r = new Map();
      assert.equal(renderTemplate(content, r), '{{CLAUDE_HOME}} not set');
    });
  });
});
