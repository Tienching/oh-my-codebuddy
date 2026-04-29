import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractOmbOwnedFromLegacyToml,
  migrateLegacyCodebuddyConfigToml,
} from '../migrate-codebuddy-config.js';

describe('extractOmbOwnedFromLegacyToml', () => {
  it('carries env keys as strings, dropping non-string values', () => {
    const extracted = extractOmbOwnedFromLegacyToml({
      env: {
        USE_OMB_EXPLORE_CMD: '1',
        OMB_DEFAULT_FRONTIER_MODEL: 'gpt-5.4',
        NUM: 7,
        OBJ: { inner: true },
        EMPTY: '   ',
      },
    });
    assert.deepEqual(extracted.env, {
      USE_OMB_EXPLORE_CMD: '1',
      OMB_DEFAULT_FRONTIER_MODEL: 'gpt-5.4',
    });
    assert.equal(extracted.providers, null);
  });

  it('carries providers.active + configs.*.env_key and preserves scalar subkeys', () => {
    const extracted = extractOmbOwnedFromLegacyToml({
      model_provider: 'azure',
      model_providers: {
        azure: {
          env_key: 'AZURE_API_KEY',
          base_url: 'https://example.com',
          wire_api: 'responses',
          nested: { ignored: true },
        },
        openai: {
          env_key: 'OPENAI_API_KEY',
        },
      },
    });
    assert.ok(extracted.providers);
    assert.equal(extracted.providers!.active, 'azure');
    assert.deepEqual(extracted.providers!.configs.azure, {
      env_key: 'AZURE_API_KEY',
      base_url: 'https://example.com',
      wire_api: 'responses',
    });
    assert.deepEqual(extracted.providers!.configs.openai, {
      env_key: 'OPENAI_API_KEY',
    });
  });

  it('drops codex-only A-class fields silently (notify, [features], [agents], etc.)', () => {
    // These fields are the ones CodeBuddy CLI does not read (verified via
    // strace on a real authenticated CBC session, 2026-04-28). Migration
    // must not carry them over.
    const extracted = extractOmbOwnedFromLegacyToml({
      notify: ['node', '/x'],
      model_reasoning_effort: 'high',
      developer_instructions: 'ignored',
      model: 'gpt-5.4',
      features: { multi_agent: true, codex_hooks: true },
      agents: { max_threads: 6 },
      tui: { status_line: ['model'] },
    });
    assert.deepEqual(extracted.env, {});
    assert.equal(extracted.providers, null);
  });

  it('returns empty when model_provider or model_providers is missing', () => {
    const extracted = extractOmbOwnedFromLegacyToml({
      model_provider: 'orphan',
      // no model_providers block
    });
    assert.equal(extracted.providers, null);
  });

  it('drops providers block entirely when model_provider points at a missing config entry (F3 guard)', () => {
    // Regression guard for architect-review F3: if the legacy TOML declared
    // `model_provider = "missing"` but had no matching
    // `[model_providers.missing]` block, we must not emit
    // `{ active: "missing", configs: {other: ...} }` into omb-config.json.
    // The downstream JSON-first read at src/config/models.ts would accept
    // that shape and short-circuit — silently skipping the TOML fallback
    // that would otherwise provide the worker API-key env override.
    const extracted = extractOmbOwnedFromLegacyToml({
      model_provider: 'missing',
      model_providers: {
        other: { env_key: 'OTHER_API_KEY' },
      },
    });
    assert.equal(
      extracted.providers,
      null,
      'dangling model_provider reference must not produce a providers block',
    );
  });
});

describe('migrateLegacyCodebuddyConfigToml', () => {
  async function withTempHome<T>(run: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'omb-migrate-'));
    try {
      return await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('returns noop when the legacy TOML does not exist', async () => {
    await withTempHome(async (dir) => {
      const result = await migrateLegacyCodebuddyConfigToml({
        legacyConfigPath: join(dir, 'config.toml'),
        dryRun: false,
        verbose: false,
      });
      assert.equal(result.noop, true);
      assert.equal(result.removedLegacy, false);
      assert.equal(result.wroteJson, false);
      assert.deepEqual(result.carriedKeys, []);
      assert.equal(existsSync(join(dir, '.omb-config.json')), false);
    });
  });

  it('migrates B-class fields to .omb-config.json and removes the TOML', async () => {
    await withTempHome(async (dir) => {
      const legacy = join(dir, 'config.toml');
      await writeFile(
        legacy,
        [
          '# omb top-level',
          'notify = ["node", "/tmp/fake-notify-hook.js"]',
          'model_reasoning_effort = "high"',
          'developer_instructions = "carryover"',
          'model = "gpt-5.4"',
          'model_provider = "azure"',
          '',
          '[features]',
          'multi_agent = true',
          'codex_hooks = true',
          '',
          '[env]',
          'USE_OMB_EXPLORE_CMD = "1"',
          'OMB_DEFAULT_FRONTIER_MODEL = "gpt-5.4"',
          '',
          '[model_providers.azure]',
          'env_key = "AZURE_API_KEY"',
          'base_url = "https://example.com"',
          '',
          '[agents]',
          'max_threads = 6',
        ].join('\n'),
      );

      const result = await migrateLegacyCodebuddyConfigToml({
        legacyConfigPath: legacy,
        dryRun: false,
        verbose: true,
      });

      assert.equal(result.noop, false);
      assert.equal(result.removedLegacy, true);
      assert.equal(result.wroteJson, true);
      assert.deepEqual(result.carriedKeys.sort(), ['env', 'providers']);
      assert.equal(existsSync(legacy), false, 'legacy TOML must be removed');

      const jsonRaw = await readFile(join(dir, '.omb-config.json'), 'utf-8');
      const json = JSON.parse(jsonRaw) as {
        env?: Record<string, string>;
        providers?: {
          active: string;
          configs: Record<string, { env_key?: string; base_url?: string }>;
        };
      };

      assert.deepEqual(json.env, {
        USE_OMB_EXPLORE_CMD: '1',
        OMB_DEFAULT_FRONTIER_MODEL: 'gpt-5.4',
      });
      assert.equal(json.providers?.active, 'azure');
      assert.equal(json.providers?.configs.azure.env_key, 'AZURE_API_KEY');
      assert.equal(json.providers?.configs.azure.base_url, 'https://example.com');
    });
  });

  it('is idempotent: running twice leaves the same state, second pass is noop', async () => {
    await withTempHome(async (dir) => {
      const legacy = join(dir, 'config.toml');
      await writeFile(
        legacy,
        [
          'model_provider = "openai"',
          '[model_providers.openai]',
          'env_key = "OPENAI_API_KEY"',
        ].join('\n'),
      );

      const first = await migrateLegacyCodebuddyConfigToml({
        legacyConfigPath: legacy,
        dryRun: false,
        verbose: false,
      });
      assert.equal(first.noop, false);
      assert.equal(first.removedLegacy, true);
      assert.equal(existsSync(legacy), false);

      const firstJsonRaw = await readFile(join(dir, '.omb-config.json'), 'utf-8');

      const second = await migrateLegacyCodebuddyConfigToml({
        legacyConfigPath: legacy,
        dryRun: false,
        verbose: false,
      });
      assert.equal(second.noop, true, 'second invocation must be a no-op');

      const secondJsonRaw = await readFile(join(dir, '.omb-config.json'), 'utf-8');
      assert.equal(firstJsonRaw, secondJsonRaw, 'json must be unchanged between runs');
    });
  });

  it('preserves existing .omb-config.json fields; JSON-side values win on conflict', async () => {
    await withTempHome(async (dir) => {
      await writeFile(
        join(dir, '.omb-config.json'),
        JSON.stringify(
          {
            env: { USE_OMB_EXPLORE_CMD: '0' /* user already set 0 */ },
            providers: {
              active: 'keep-me',
              configs: { 'keep-me': { env_key: 'KEEP_KEY' } },
            },
            tui: { statusLine: ['model'] } /* unrelated preexisting block */,
          },
          null,
          2,
        ),
      );
      // Legacy TOML declares model_provider = "legacy" with a matching
      // [model_providers.legacy] block so extraction returns a well-formed
      // providers payload. F3 guards against dangling active pointers
      // separately (see the dedicated "drops providers block" test).
      await writeFile(
        join(dir, 'config.toml'),
        [
          'model_provider = "legacy"',
          '[model_providers.legacy]',
          'env_key = "LEGACY_KEY"',
          '[model_providers.newbie]',
          'env_key = "NEWBIE_KEY"',
          '[env]',
          'USE_OMB_EXPLORE_CMD = "1"',
          'NEW_ENV_KEY = "new-value"',
        ].join('\n'),
      );

      await migrateLegacyCodebuddyConfigToml({
        legacyConfigPath: join(dir, 'config.toml'),
        dryRun: false,
        verbose: false,
      });

      const json = JSON.parse(await readFile(join(dir, '.omb-config.json'), 'utf-8')) as {
        env: Record<string, string>;
        providers: {
          active: string;
          configs: Record<string, { env_key?: string }>;
        };
        tui?: { statusLine: string[] };
      };

      // Existing JSON wins on conflict (both active provider and env var).
      assert.equal(json.providers.active, 'keep-me');
      assert.equal(json.env.USE_OMB_EXPLORE_CMD, '0');
      // TOML-only keys/providers are backfilled.
      assert.equal(json.env.NEW_ENV_KEY, 'new-value');
      assert.equal(json.providers.configs['keep-me'].env_key, 'KEEP_KEY');
      assert.equal(json.providers.configs.legacy.env_key, 'LEGACY_KEY');
      assert.equal(json.providers.configs.newbie.env_key, 'NEWBIE_KEY');
      // Unrelated blocks are untouched.
      assert.deepEqual(json.tui, { statusLine: ['model'] });
    });
  });

  it('dry-run does not touch the filesystem', async () => {
    await withTempHome(async (dir) => {
      const legacy = join(dir, 'config.toml');
      await writeFile(legacy, 'model_provider = "a"\n[model_providers.a]\nenv_key = "A_KEY"\n');
      const result = await migrateLegacyCodebuddyConfigToml({
        legacyConfigPath: legacy,
        dryRun: true,
        verbose: false,
      });
      assert.equal(result.noop, false);
      assert.equal(existsSync(legacy), true, 'dry-run must leave the legacy TOML in place');
      assert.equal(
        existsSync(join(dir, '.omb-config.json')),
        false,
        'dry-run must not write the JSON',
      );
    });
  });

  it('heals a pre-F3 dangling providers block in existing .omb-config.json on re-migration (R1 guard)', async () => {
    // Architect-review R1: users who ran the pre-F3 migrator may already
    // have `.omb-config.json` with a dangling `providers.active` pointing at
    // a config entry that was never written. Re-running setup after the
    // F3 fix must heal that state, not preserve it.
    await withTempHome(async (dir) => {
      // Pre-F3 garbage: active="ghost" but configs only has "other".
      await writeFile(
        join(dir, '.omb-config.json'),
        JSON.stringify({
          providers: {
            active: 'ghost',
            configs: { other: { env_key: 'OTHER_KEY' } },
          },
        }),
      );
      // Legacy TOML with a well-formed provider the migrator normally would
      // merge in.
      await writeFile(
        join(dir, 'config.toml'),
        [
          'model_provider = "legacy"',
          '[model_providers.legacy]',
          'env_key = "LEGACY_KEY"',
        ].join('\n'),
      );

      await migrateLegacyCodebuddyConfigToml({
        legacyConfigPath: join(dir, 'config.toml'),
        dryRun: false,
        verbose: false,
      });

      const json = JSON.parse(await readFile(join(dir, '.omb-config.json'), 'utf-8')) as {
        providers?: { active?: string; configs?: Record<string, unknown> };
      };
      // The dangling providers block must be stripped entirely so the
      // downstream JSON-first read doesn't short-circuit on a broken shape.
      assert.equal(
        json.providers,
        undefined,
        'dangling providers block must be stripped on re-migration',
      );
    });
  });
});
