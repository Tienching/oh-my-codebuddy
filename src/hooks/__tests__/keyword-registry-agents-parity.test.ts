/**
 * Regression guards covering AGENTS.md ↔ keyword-registry agreement.
 *
 * Why this test exists
 * --------------------
 * Until 2026-04-27 AGENTS.md reproduced a full markdown table of keyword
 * triggers and their SKILL.md targets. That table repeatedly drifted from the
 * runtime source of truth (`src/hooks/keyword-registry.ts`): web-clone triggers
 * were registered in one place but not the other; `ecomode`/`eco`/`budget`
 * lived in AGENTS.md only; a botched merge left two empty `| Keyword(s) |`
 * headers stranded in templates/AGENTS.md.
 *
 * The production fix (cribbed from oh-my-codex) is to drop the table from
 * AGENTS.md entirely and treat `keyword-registry.ts` as the sole source of
 * truth, with hook-injected routing context being authoritative per turn.
 * This test freezes that invariant:
 *
 *   1. No table rows in the keyword_detection block — the table is gone on
 *      purpose; reintroducing it invites future drift.
 *   2. The prose callouts that remain (`$name` examples inside
 *      keyword_detection) must refer to keywords the registry knows about,
 *      otherwise downstream consumers (`recordSkillActivation`, ralplan-first
 *      gate, cancel, HUD) can't see the activation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYWORD_TRIGGER_DEFINITIONS } from '../keyword-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../../../');

function extractKeywordDetectionBlock(content: string): string {
  const start = content.indexOf('<keyword_detection>');
  if (start === -1) return '';
  const end = content.indexOf('</keyword_detection>', start);
  if (end === -1) return '';
  return content.slice(start, end);
}

function extractDollarKeywordsFromBlock(block: string): string[] {
  // Collect every `$token` mentioned in prose (examples like "$analyze",
  // "$deep-interview"). These are the user-facing triggers AGENTS.md
  // promises the LLM will honour — the registry must back each one.
  const tokens = new Set<string>();
  const rx = /\$([a-z][a-z0-9-]+)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(block)) !== null) {
    tokens.add(match[1].toLowerCase());
  }
  return [...tokens];
}

// Explicit aliases from extractExplicitSkillInvocations (keyword-detector.ts)
// — `$swarm` rewrites to `team`, `$ulw`/`$ecomode`/`$eco`/`$budget` rewrite
// to `ultrawork`. Those aren't literal registry skill names but they are
// legitimate user-facing triggers, so the parity guard must accept them.
const EXPLICIT_TOKEN_ALIASES: Record<string, string> = {
  swarm: 'team',
  ulw: 'ultrawork',
  ecomode: 'ultrawork',
  eco: 'ultrawork',
  budget: 'ultrawork',
};

// Meta placeholders that appear inside prose sentences like "explicit $name
// invocations" or "$skill invocation". They are intentionally not real
// keywords — they're English grammar around how we *talk* about keywords.
const DOC_META_PLACEHOLDERS = new Set(['name', 'skill']);

const REGISTRY_KEYWORDS = new Set(
  KEYWORD_TRIGGER_DEFINITIONS.map((entry) => entry.keyword.toLowerCase()),
);
const REGISTRY_SKILLS = new Set(
  KEYWORD_TRIGGER_DEFINITIONS.map((entry) => entry.skill.toLowerCase()),
);

function describeFile(relativePath: string): void {
  describe(`AGENTS.md keyword_detection parity (${relativePath})`, () => {
    const content = readFileSync(join(repoRoot, relativePath), 'utf-8');
    const block = extractKeywordDetectionBlock(content);

    it('declares a keyword_detection block', () => {
      assert.ok(block.length > 0, `${relativePath} is missing a <keyword_detection> block`);
    });

    it('does NOT contain a keyword trigger table', () => {
      // The 2026-04-27 migration removed the table. Re-introducing one would
      // bring back the drift the registry is supposed to eliminate; it would
      // also make stranded table headers (the original bug) possible again.
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|')) continue;
        const looksLikeTable = /\| Keyword\(s\) \|/i.test(trimmed)
          || /^\|\s*-+\s*\|/.test(trimmed)
          || /^\| "[^"]+"/.test(trimmed);
        assert.equal(
          looksLikeTable,
          false,
          `${relativePath} keyword_detection block should not contain a trigger table row: ${trimmed}`,
        );
      }
    });

    it('only references $keywords that the registry actually handles', () => {
      const mentioned = extractDollarKeywordsFromBlock(block);
      const unknown = mentioned.filter((token) => {
        if (REGISTRY_KEYWORDS.has(token)) return false;
        if (REGISTRY_SKILLS.has(token)) return false;
        if (token in EXPLICIT_TOKEN_ALIASES) return false;
        if (DOC_META_PLACEHOLDERS.has(token)) return false;
        return true;
      });
      assert.deepEqual(
        unknown,
        [],
        `${relativePath} keyword_detection references $tokens that are not in keyword-registry or known explicit aliases: ${unknown.join(', ')}`,
      );
    });
  });
}

describeFile('AGENTS.md');
describeFile('templates/AGENTS.md');
