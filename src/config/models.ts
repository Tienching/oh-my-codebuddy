/**
 * Model Configuration
 *
 * Reads per-mode model overrides and default-env overrides from .omb-config.json,
 * with legacy .omb-config.json compatibility.
 *
 * Config format:
 * {
 *   "env": {
 *     "OMB_DEFAULT_FRONTIER_MODEL": "your-frontier-model",
 *     "OMB_DEFAULT_STANDARD_MODEL": "your-standard-model",
 *     "OMB_DEFAULT_SPARK_MODEL": "your-spark-model"
 *   },
 *   "models": {
 *     "default": "o4-mini",
 *     "team": "gpt-4.1"
 *   }
 * }
 *
 * Resolution: mode-specific > "default" key > OMB_DEFAULT_FRONTIER_MODEL > DEFAULT_FRONTIER_MODEL
 */

import { parse as parseToml } from '@iarna/toml';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { codebuddyConfigPath, codebuddyHome } from '../utils/paths.js';

export interface ModelsConfig {
  [mode: string]: string | undefined;
}

export interface OmbConfigEnv {
  [key: string]: string | undefined;
}

export interface OmbConfigProviderEntry {
  env_key?: string;
  [key: string]: unknown;
}

export interface OmbConfigProviders {
  active?: string;
  configs?: Record<string, OmbConfigProviderEntry>;
}

interface OmbConfigFile {
  env?: OmbConfigEnv;
  models?: ModelsConfig;
  /**
   * Per-OMB active model-provider selection. Mirrors Codex's `model_provider` +
   * `[model_providers.<name>].env_key` schema but lives in `.omb-config.json` so
   * CodeBuddy-provider installs don't need to carry a codex-format `config.toml`.
   */
  providers?: OmbConfigProviders;
}

interface CodexConfigFile {
  model_provider?: unknown;
  model_providers?: Record<string, unknown>;
}

export const OMB_DEFAULT_FRONTIER_MODEL_ENV = 'OMB_DEFAULT_FRONTIER_MODEL';
export const OMB_DEFAULT_STANDARD_MODEL_ENV = 'OMB_DEFAULT_STANDARD_MODEL';
export const OMB_DEFAULT_SPARK_MODEL_ENV = 'OMB_DEFAULT_SPARK_MODEL';
export const OMB_SPARK_MODEL_ENV = 'OMB_SPARK_MODEL';

const PRIMARY_CONFIG_BASENAME = '.omb-config.json';
const LEGACY_CONFIG_BASENAME = '.omb-config.json';

function getManagedConfigCandidates(codebuddyHomeOverride?: string): string[] {
  const homeDir = codebuddyHomeOverride || codebuddyHome();
  return [
    join(homeDir, PRIMARY_CONFIG_BASENAME),
    join(homeDir, LEGACY_CONFIG_BASENAME),
  ];
}

function readOmbConfigFile(codebuddyHomeOverride?: string): OmbConfigFile | null {
  for (const configPath of getManagedConfigCandidates(codebuddyHomeOverride)) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      return raw as OmbConfigFile;
    } catch {
      return null;
    }
  }
  return null;
}

function readCodexConfigFile(codebuddyHomeOverride?: string): CodexConfigFile | null {
  const configPath = codebuddyHomeOverride
    ? join(codebuddyHomeOverride, 'config.toml')
    : codebuddyConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    const raw = parseToml(readFileSync(configPath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as CodexConfigFile;
  } catch {
    return null;
  }
}

function readModelsBlock(codebuddyHomeOverride?: string): ModelsConfig | null {
  const config = readOmbConfigFile(codebuddyHomeOverride);
  if (!config) return null;
  if (config.models && typeof config.models === 'object' && !Array.isArray(config.models)) {
    return config.models;
  }
  return null;
}

export const DEFAULT_FRONTIER_MODEL = 'gpt-5.4';
export const DEFAULT_STANDARD_MODEL = 'gpt-5.4-mini';
export const DEFAULT_SPARK_MODEL = 'gpt-5.3-codex-spark';

function normalizeConfiguredValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readConfigEnvValue(
  keys: readonly string[],
  codebuddyHomeOverride?: string,
): string | undefined {
  const config = readOmbConfigFile(codebuddyHomeOverride);
  if (!config || !config.env || typeof config.env !== 'object' || Array.isArray(config.env)) {
    return undefined;
  }
  for (const key of keys) {
    const value = normalizeConfiguredValue(config.env[key]);
    if (value) return value;
  }
  return undefined;
}

function readTeamLowComplexityOverride(codebuddyHomeOverride?: string): string | undefined {
  const models = readModelsBlock(codebuddyHomeOverride);
  if (!models) return undefined;
  for (const key of TEAM_LOW_COMPLEXITY_MODEL_KEYS) {
    const value = normalizeConfiguredValue(models[key]);
    if (value) return value;
  }
  return undefined;
}

function readEnvValue(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = normalizeConfiguredValue(env[key]);
    if (value) return value;
  }
  return undefined;
}

export function readConfiguredEnvOverrides(codebuddyHomeOverride?: string): NodeJS.ProcessEnv {
  const config = readOmbConfigFile(codebuddyHomeOverride);
  if (!config || !config.env || typeof config.env !== 'object' || Array.isArray(config.env)) {
    return {};
  }

  const resolved: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(config.env)) {
    const normalized = normalizeConfiguredValue(value);
    if (!normalized) continue;
    resolved[key] = normalized;
  }

  const frontier = readConfigEnvValue(
    [OMB_DEFAULT_FRONTIER_MODEL_ENV, OMB_DEFAULT_FRONTIER_MODEL_ENV],
    codebuddyHomeOverride,
  );
  const standard = readConfigEnvValue(
    [OMB_DEFAULT_STANDARD_MODEL_ENV, OMB_DEFAULT_STANDARD_MODEL_ENV],
    codebuddyHomeOverride,
  );
  const spark = readConfigEnvValue(
    [OMB_DEFAULT_SPARK_MODEL_ENV, OMB_SPARK_MODEL_ENV, OMB_DEFAULT_SPARK_MODEL_ENV, OMB_SPARK_MODEL_ENV],
    codebuddyHomeOverride,
  );

  if (frontier) resolved[OMB_DEFAULT_FRONTIER_MODEL_ENV] = frontier;
  if (standard) resolved[OMB_DEFAULT_STANDARD_MODEL_ENV] = standard;
  if (spark) resolved[OMB_DEFAULT_SPARK_MODEL_ENV] = spark;

  return resolved;
}

export function readActiveProviderEnvOverrides(
  env: NodeJS.ProcessEnv = process.env,
  codebuddyHomeOverride?: string,
): NodeJS.ProcessEnv {
  // Primary source: .omb-config.json providers.active + configs.<name>.env_key.
  // This lets CodeBuddy-provider installs drop the legacy config.toml zombie
  // while keeping the worker-env API-key injection path intact.
  const ombConfig = readOmbConfigFile(codebuddyHomeOverride);
  const ombProviders = ombConfig?.providers;
  if (ombProviders && typeof ombProviders === 'object' && !Array.isArray(ombProviders)) {
    const activeFromJson = normalizeConfiguredValue(ombProviders.active);
    const configsFromJson = ombProviders.configs;
    if (
      activeFromJson
      && configsFromJson
      && typeof configsFromJson === 'object'
      && !Array.isArray(configsFromJson)
    ) {
      const entry = configsFromJson[activeFromJson];
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const envKey = normalizeConfiguredValue(entry.env_key);
        if (envKey) {
          const envValue = normalizeConfiguredValue(env[envKey]);
          return envValue ? { [envKey]: envValue } : {};
        }
      }
    }
  }

  // Fallback: legacy ~/.codebuddy/config.toml (or Codex ~/.codex/config.toml)
  // read of model_provider + model_providers.<p>.env_key. Kept for
  // upgrade-but-not-yet-resetup users and for Codex provider installs which
  // still write the TOML natively. Scheduled for removal in v0.14 for
  // CodeBuddy-provider homes (see docs/deprecation-policy.md).
  const config = readCodexConfigFile(codebuddyHomeOverride);
  if (!config) return {};

  const activeProvider = normalizeConfiguredValue(config.model_provider);
  if (!activeProvider) return {};

  const providers = config.model_providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    return {};
  }

  const providerConfig = providers[activeProvider];
  if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) {
    return {};
  }

  const envKey = normalizeConfiguredValue((providerConfig as Record<string, unknown>).env_key);
  if (!envKey) return {};

  const envValue = normalizeConfiguredValue(env[envKey]);
  return envValue ? { [envKey]: envValue } : {};
}

export function getEnvConfiguredMainDefaultModel(
  env: NodeJS.ProcessEnv = process.env,
  codebuddyHomeOverride?: string,
): string | undefined {
  return readEnvValue(env, [OMB_DEFAULT_FRONTIER_MODEL_ENV, OMB_DEFAULT_FRONTIER_MODEL_ENV])
    ?? readConfigEnvValue([OMB_DEFAULT_FRONTIER_MODEL_ENV, OMB_DEFAULT_FRONTIER_MODEL_ENV], codebuddyHomeOverride);
}

export function getEnvConfiguredStandardDefaultModel(
  env: NodeJS.ProcessEnv = process.env,
  codebuddyHomeOverride?: string,
): string | undefined {
  return readEnvValue(env, [OMB_DEFAULT_STANDARD_MODEL_ENV, OMB_DEFAULT_STANDARD_MODEL_ENV])
    ?? readConfigEnvValue([OMB_DEFAULT_STANDARD_MODEL_ENV, OMB_DEFAULT_STANDARD_MODEL_ENV], codebuddyHomeOverride);
}

export function getEnvConfiguredSparkDefaultModel(
  env: NodeJS.ProcessEnv = process.env,
  codebuddyHomeOverride?: string,
): string | undefined {
  return readEnvValue(env, [
    OMB_DEFAULT_SPARK_MODEL_ENV,
    OMB_SPARK_MODEL_ENV,
    OMB_DEFAULT_SPARK_MODEL_ENV,
    OMB_SPARK_MODEL_ENV,
  ]) ?? readConfigEnvValue([
    OMB_DEFAULT_SPARK_MODEL_ENV,
    OMB_SPARK_MODEL_ENV,
    OMB_DEFAULT_SPARK_MODEL_ENV,
    OMB_SPARK_MODEL_ENV,
  ], codebuddyHomeOverride);
}

/**
 * Get the envvar-backed main/default model.
 * Resolution: OMB_DEFAULT_FRONTIER_MODEL > OMB_DEFAULT_FRONTIER_MODEL > DEFAULT_FRONTIER_MODEL
 */
export function getMainDefaultModel(codebuddyHomeOverride?: string): string {
  return getEnvConfiguredMainDefaultModel(process.env, codebuddyHomeOverride)
    ?? DEFAULT_FRONTIER_MODEL;
}

/**
 * Get the envvar-backed standard/default subagent model.
 * Resolution: OMB_DEFAULT_STANDARD_MODEL > OMB_DEFAULT_STANDARD_MODEL > DEFAULT_STANDARD_MODEL
 */
export function getStandardDefaultModel(codebuddyHomeOverride?: string): string {
  return getEnvConfiguredStandardDefaultModel(process.env, codebuddyHomeOverride)
    ?? DEFAULT_STANDARD_MODEL;
}

/**
 * Get the configured model for a specific mode.
 * Resolution: mode-specific override > "default" key > OMB_DEFAULT_FRONTIER_MODEL > DEFAULT_FRONTIER_MODEL
 */
export function getModelForMode(mode: string, codebuddyHomeOverride?: string): string {
  const models = readModelsBlock(codebuddyHomeOverride);
  const modeValue = normalizeConfiguredValue(models?.[mode]);
  if (modeValue) return modeValue;

  const defaultValue = normalizeConfiguredValue(models?.default);
  if (defaultValue) return defaultValue;

  return getMainDefaultModel(codebuddyHomeOverride);
}

const TEAM_LOW_COMPLEXITY_MODEL_KEYS = [
  'team_low_complexity',
  'team-low-complexity',
  'teamLowComplexity',
];

/**
 * Get the envvar-backed spark/low-complexity default model.
 * Resolution: OMB_DEFAULT_SPARK_MODEL > OMB_SPARK_MODEL > OMB_DEFAULT_SPARK_MODEL > OMB_SPARK_MODEL > explicit low-complexity key(s) > DEFAULT_SPARK_MODEL
 */
export function getSparkDefaultModel(codebuddyHomeOverride?: string): string {
  return getEnvConfiguredSparkDefaultModel(process.env, codebuddyHomeOverride)
    ?? readTeamLowComplexityOverride(codebuddyHomeOverride)
    ?? DEFAULT_SPARK_MODEL;
}

/**
 * Get the low-complexity team worker model.
 * Resolution: explicit low-complexity key(s) > OMB_DEFAULT_SPARK_MODEL > OMB_SPARK_MODEL > OMB_DEFAULT_SPARK_MODEL > OMB_SPARK_MODEL > DEFAULT_SPARK_MODEL
 */
export function getTeamLowComplexityModel(codebuddyHomeOverride?: string): string {
  return readTeamLowComplexityOverride(codebuddyHomeOverride) ?? getSparkDefaultModel(codebuddyHomeOverride);
}
