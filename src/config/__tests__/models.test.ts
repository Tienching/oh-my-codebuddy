import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  DEFAULT_FRONTIER_MODEL,
  DEFAULT_STANDARD_MODEL,
  DEFAULT_SPARK_MODEL,
  getEnvConfiguredStandardDefaultModel,
  getMainDefaultModel,
  getModelForMode,
  getSparkDefaultModel,
  getStandardDefaultModel,
  getTeamLowComplexityModel,
  readActiveProviderEnvOverrides,
  readConfiguredEnvOverrides,
} from '../models.js';

describe('getModelForMode', () => {
  let tempDir: string;
  let originalCodexHome: string | undefined;
  let originalDefaultFrontierModel: string | undefined;
  let originalDefaultStandardModel: string | undefined;
  let originalDefaultSparkModel: string | undefined;
  let originalSparkModel: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omb-models-'));
    originalCodexHome = process.env.CODEBUDDY_HOME;
    originalDefaultFrontierModel = process.env.OMB_DEFAULT_FRONTIER_MODEL;
    originalDefaultStandardModel = process.env.OMB_DEFAULT_STANDARD_MODEL;
    originalDefaultSparkModel = process.env.OMB_DEFAULT_SPARK_MODEL;
    originalSparkModel = process.env.OMB_SPARK_MODEL;
    process.env.CODEBUDDY_HOME = tempDir;
    delete process.env.OMB_DEFAULT_FRONTIER_MODEL;
    delete process.env.OMB_DEFAULT_STANDARD_MODEL;
    delete process.env.OMB_DEFAULT_SPARK_MODEL;
    delete process.env.OMB_SPARK_MODEL;
  });

  afterEach(async () => {
    if (typeof originalCodexHome === 'string') {
      process.env.CODEBUDDY_HOME = originalCodexHome;
    } else {
      delete process.env.CODEBUDDY_HOME;
    }
    if (typeof originalDefaultFrontierModel === 'string') {
      process.env.OMB_DEFAULT_FRONTIER_MODEL = originalDefaultFrontierModel;
    } else {
      delete process.env.OMB_DEFAULT_FRONTIER_MODEL;
    }
    if (typeof originalDefaultStandardModel === 'string') {
      process.env.OMB_DEFAULT_STANDARD_MODEL = originalDefaultStandardModel;
    } else {
      delete process.env.OMB_DEFAULT_STANDARD_MODEL;
    }
    if (typeof originalDefaultSparkModel === 'string') {
      process.env.OMB_DEFAULT_SPARK_MODEL = originalDefaultSparkModel;
    } else {
      delete process.env.OMB_DEFAULT_SPARK_MODEL;
    }
    if (typeof originalSparkModel === 'string') {
      process.env.OMB_SPARK_MODEL = originalSparkModel;
    } else {
      delete process.env.OMB_SPARK_MODEL;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(config: Record<string, unknown>): Promise<void> {
    await writeFile(join(tempDir, '.omb-config.json'), JSON.stringify(config));
  }

  it('returns frontier default when config file does not exist', () => {
    assert.equal(getModelForMode('team'), DEFAULT_FRONTIER_MODEL);
  });

  it('returns frontier default when config has no models section', async () => {
    await writeConfig({ notifications: { enabled: false } });
    assert.equal(getModelForMode('team'), DEFAULT_FRONTIER_MODEL);
  });

  it('returns mode-specific model when configured', async () => {
    await writeConfig({ models: { team: 'gpt-4.1', default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'gpt-4.1');
  });

  it('falls back to default when mode-specific model is not set', async () => {
    await writeConfig({ models: { default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'o4-mini');
  });

  it('returns frontier default when models section is empty', async () => {
    await writeConfig({ models: {} });
    assert.equal(getModelForMode('team'), DEFAULT_FRONTIER_MODEL);
  });

  it('ignores empty string values and falls back to default', async () => {
    await writeConfig({ models: { team: '', default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'o4-mini');
  });

  it('trims whitespace from model values', async () => {
    await writeConfig({ models: { team: '  gpt-4.1  ' } });
    assert.equal(getModelForMode('team'), 'gpt-4.1');
  });

  it('resolves different modes independently', async () => {
    await writeConfig({ models: { team: 'gpt-4.1', autopilot: 'o4-mini', ralph: 'gpt-5' } });
    assert.equal(getModelForMode('team'), 'gpt-4.1');
    assert.equal(getModelForMode('autopilot'), 'o4-mini');
    assert.equal(getModelForMode('ralph'), 'gpt-5');
  });

  it('returns frontier default for invalid models section (array)', async () => {
    await writeConfig({ models: ['not', 'valid'] });
    assert.equal(getModelForMode('team'), DEFAULT_FRONTIER_MODEL);
  });

  it('returns frontier default for malformed JSON', async () => {
    await writeFile(join(tempDir, '.omb-config.json'), 'not-json');
    assert.equal(getModelForMode('team'), DEFAULT_FRONTIER_MODEL);
  });

  it('uses OMB_DEFAULT_FRONTIER_MODEL when config does not provide a value', () => {
    process.env.OMB_DEFAULT_FRONTIER_MODEL = 'gpt-5.4-mini';
    assert.equal(getMainDefaultModel(), 'gpt-5.4-mini');
    assert.equal(getModelForMode('team'), 'gpt-5.4-mini');
  });

  it('uses .omb-config.json env.OMB_DEFAULT_FRONTIER_MODEL when shell env is absent', async () => {
    await writeConfig({ env: { OMB_DEFAULT_FRONTIER_MODEL: 'frontier-local' } });
    assert.equal(getMainDefaultModel(), 'frontier-local');
    assert.equal(getModelForMode('team'), 'frontier-local');
  });

  it('uses OMB_DEFAULT_STANDARD_MODEL when configured in shell env', () => {
    process.env.OMB_DEFAULT_STANDARD_MODEL = 'gpt-5.4-mini-tuned';
    assert.equal(getEnvConfiguredStandardDefaultModel(), 'gpt-5.4-mini-tuned');
    assert.equal(getStandardDefaultModel(), 'gpt-5.4-mini-tuned');
  });

  it('uses .omb-config.json env.OMB_DEFAULT_STANDARD_MODEL when shell env is absent', async () => {
    await writeConfig({ env: { OMB_DEFAULT_STANDARD_MODEL: 'standard-local' } });
    assert.equal(getEnvConfiguredStandardDefaultModel(), 'standard-local');
    assert.equal(getStandardDefaultModel(), 'standard-local');
  });

  it('prefers shell OMB_DEFAULT_FRONTIER_MODEL over .omb-config.json env override', async () => {
    process.env.OMB_DEFAULT_FRONTIER_MODEL = 'frontier-shell';
    await writeConfig({ env: { OMB_DEFAULT_FRONTIER_MODEL: 'frontier-local' } });
    assert.equal(getMainDefaultModel(), 'frontier-shell');
  });

  it('keeps explicit config default ahead of OMB_DEFAULT_FRONTIER_MODEL', async () => {
    process.env.OMB_DEFAULT_FRONTIER_MODEL = 'gpt-5.4-mini';
    await writeConfig({ models: { default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'o4-mini');
  });

  it('keeps explicit mode config ahead of OMB_DEFAULT_FRONTIER_MODEL', async () => {
    process.env.OMB_DEFAULT_FRONTIER_MODEL = 'gpt-5.4-mini';
    await writeConfig({ models: { team: 'gpt-4.1', default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'gpt-4.1');
  });

  it('returns low-complexity team model when configured', async () => {
    await writeConfig({ models: { team_low_complexity: 'gpt-4.1-mini' } });
    assert.equal(getTeamLowComplexityModel(), 'gpt-4.1-mini');
  });

  it('uses OMB_DEFAULT_SPARK_MODEL when low-complexity config is absent', async () => {
    process.env.OMB_DEFAULT_SPARK_MODEL = 'gpt-5.3-codex-spark-fast';
    await writeConfig({ models: { team: 'gpt-4.1' } });
    assert.equal(getSparkDefaultModel(), 'gpt-5.3-codex-spark-fast');
    assert.equal(getTeamLowComplexityModel(), 'gpt-5.3-codex-spark-fast');
  });

  it('uses .omb-config.json env.OMB_DEFAULT_SPARK_MODEL when shell env is absent', async () => {
    await writeConfig({ env: { OMB_DEFAULT_SPARK_MODEL: 'spark-local' }, models: { team: 'gpt-4.1' } });
    assert.equal(getSparkDefaultModel(), 'spark-local');
  });

  it('falls back to legacy OMB_SPARK_MODEL when canonical spark env is absent', async () => {
    process.env.OMB_SPARK_MODEL = 'gpt-5.3-codex-spark-fast';
    await writeConfig({ models: { team: 'gpt-4.1' } });
    assert.equal(getSparkDefaultModel(), 'gpt-5.3-codex-spark-fast');
    assert.equal(getTeamLowComplexityModel(), 'gpt-5.3-codex-spark-fast');
  });

  it('prefers OMB_DEFAULT_SPARK_MODEL over legacy OMB_SPARK_MODEL', () => {
    process.env.OMB_DEFAULT_SPARK_MODEL = 'spark-canonical';
    process.env.OMB_SPARK_MODEL = 'spark-legacy';
    assert.equal(getSparkDefaultModel(), 'spark-canonical');
  });

  it('reads normalized env overrides from .omb-config.json', async () => {
    await writeConfig({
      env: {
        OMB_DEFAULT_FRONTIER_MODEL: ' frontier-local ',
        OMB_DEFAULT_STANDARD_MODEL: ' standard-local ',
        OMB_DEFAULT_SPARK_MODEL: ' spark-local ',
        EMPTY: '   ',
      },
    });
    assert.deepEqual(readConfiguredEnvOverrides(), {
      OMB_DEFAULT_FRONTIER_MODEL: 'frontier-local',
      OMB_DEFAULT_STANDARD_MODEL: 'standard-local',
      OMB_DEFAULT_SPARK_MODEL: 'spark-local',
    });
  });

  it('keeps explicit low-complexity config ahead of OMB_DEFAULT_SPARK_MODEL', async () => {
    process.env.OMB_DEFAULT_SPARK_MODEL = 'gpt-5.3-codex-spark-fast';
    await writeConfig({ models: { team_low_complexity: 'gpt-4.1-mini' } });
    assert.equal(getTeamLowComplexityModel(), 'gpt-4.1-mini');
  });

  it('returns canonical spark fallback when not configured', async () => {
    await writeConfig({ models: { team: 'gpt-4.1' } });
    assert.equal(getStandardDefaultModel(), DEFAULT_STANDARD_MODEL);
    assert.equal(getSparkDefaultModel(), DEFAULT_SPARK_MODEL);
    assert.equal(getTeamLowComplexityModel(), DEFAULT_SPARK_MODEL);
  });

  it('readActiveProviderEnvOverrides reads providers.active from .omb-config.json first', async () => {
    // Regression guard for the config.toml zombie migration: the model_provider
    // + model_providers.<p>.env_key schema now lives in .omb-config.json under
    // `providers.active` + `providers.configs.<p>.env_key`. This test pins the
    // primary read path so the TOML fallback can be retired on schedule.
    await writeConfig({
      providers: {
        active: 'custom',
        configs: { custom: { env_key: 'CUSTOM_API_KEY' } },
      },
    });
    const overrides = readActiveProviderEnvOverrides(
      { CUSTOM_API_KEY: 'sk-primary' },
      tempDir,
    );
    assert.deepEqual(overrides, { CUSTOM_API_KEY: 'sk-primary' });
  });

  it('readActiveProviderEnvOverrides returns empty when env key is not set', async () => {
    await writeConfig({
      providers: {
        active: 'custom',
        configs: { custom: { env_key: 'CUSTOM_API_KEY' } },
      },
    });
    const overrides = readActiveProviderEnvOverrides({}, tempDir);
    assert.deepEqual(overrides, {});
  });

  it('readActiveProviderEnvOverrides falls back to config.toml when .omb-config.json providers block is missing', async () => {
    // Upgrade-but-not-yet-setup path: users who upgrade OMB but have not yet
    // rerun `omb setup` still need worker env API-key injection to work from
    // the legacy ~/.codebuddy/config.toml. Drop this fallback once v0.14 lands.
    await writeFile(
      join(tempDir, 'config.toml'),
      [
        'model_provider = "fallback_prov"',
        '[model_providers.fallback_prov]',
        'env_key = "FALLBACK_API_KEY"',
      ].join('\n'),
    );
    const overrides = readActiveProviderEnvOverrides(
      { FALLBACK_API_KEY: 'sk-fallback' },
      tempDir,
    );
    assert.deepEqual(overrides, { FALLBACK_API_KEY: 'sk-fallback' });
  });

  it('readActiveProviderEnvOverrides prefers .omb-config.json over a coexisting config.toml', async () => {
    await writeConfig({
      providers: {
        active: 'primary',
        configs: { primary: { env_key: 'PRIMARY_API_KEY' } },
      },
    });
    await writeFile(
      join(tempDir, 'config.toml'),
      [
        'model_provider = "legacy"',
        '[model_providers.legacy]',
        'env_key = "LEGACY_API_KEY"',
      ].join('\n'),
    );
    const overrides = readActiveProviderEnvOverrides(
      { PRIMARY_API_KEY: 'sk-primary', LEGACY_API_KEY: 'sk-legacy' },
      tempDir,
    );
    assert.deepEqual(overrides, { PRIMARY_API_KEY: 'sk-primary' });
  });

  it('readActiveProviderEnvOverrides falls back to config.toml when .omb-config.json has env but no providers block', async () => {
    // Regression guard: users may set env overrides via the migrated
    // .omb-config.json while still relying on the legacy TOML's
    // model_provider block (e.g. upgrade-but-not-yet-resetup). The presence
    // of an env block must not short-circuit the providers lookup.
    await writeConfig({
      env: { OMB_DEFAULT_FRONTIER_MODEL: 'frontier-from-json' },
    });
    await writeFile(
      join(tempDir, 'config.toml'),
      [
        'model_provider = "legacy"',
        '[model_providers.legacy]',
        'env_key = "LEGACY_API_KEY"',
      ].join('\n'),
    );
    const overrides = readActiveProviderEnvOverrides(
      { LEGACY_API_KEY: 'sk-legacy' },
      tempDir,
    );
    assert.deepEqual(overrides, { LEGACY_API_KEY: 'sk-legacy' });
  });
});
