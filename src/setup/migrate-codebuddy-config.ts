/**
 * Migrates a legacy `~/.codebuddy/config.toml` (codex-format zombie) into the
 * CodeBuddy-native storage: `.omb-config.json`. After migration the legacy
 * TOML file is deleted so the provider home stops carrying a file the
 * CodeBuddy CLI never reads.
 *
 * Scope (per ADR `adr-fix-codebuddy-config-toml-zombie.md`):
 * - Only OMB-consumed fields are carried over: `model_provider` +
 *   `[model_providers.*]` → `.omb-config.json#/providers`; `[env]` → merged
 *   into `.omb-config.json#/env`.
 * - All other fields (notify, model, model_reasoning_effort, [features],
 *   [agents], [tui], developer_instructions, ...) are **intentionally
 *   dropped**: they are codex-format schema that CodeBuddy CLI does not
 *   read, and nothing in OMB's runtime path needs them for a codebuddy
 *   provider home (Codex-provider homes keep writing the TOML natively and
 *   are not touched by this migrator).
 *
 * Non-goals:
 * - Does not touch `~/.codex/config.toml` (Codex provider is unaffected).
 * - Does not touch `settings.json`, `hooks.json`, or anything outside the
 *   single TOML file being migrated.
 * - Idempotent: re-running with no legacy TOML present is a no-op.
 */

import { existsSync } from "fs";
import { readFile, rm, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { parse as parseToml } from "@iarna/toml";

const OMB_MANAGED_CONFIG_BASENAME = ".omb-config.json";

export interface MigrateLegacyCodebuddyConfigOptions {
  /**
   * Full path to the legacy `config.toml` candidate (typically
   * `{codebuddyHome}/config.toml`). The migrator treats this as the
   * single source to retire.
   */
  legacyConfigPath: string;
  /**
   * When true, do not write `.omb-config.json` and do not delete the TOML;
   * only report what the migration would do.
   */
  dryRun: boolean;
  verbose: boolean;
}

export interface MigrateLegacyCodebuddyConfigResult {
  /** Legacy TOML did not exist; migration was a no-op. */
  noop: boolean;
  /** True when legacy TOML exists and was deleted (or would have been in dry-run). */
  removedLegacy: boolean;
  /** True when .omb-config.json was updated (or would have been). */
  wroteJson: boolean;
  /** Keys that were carried over (for observability). */
  carriedKeys: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface ExtractedOmbOwnedFields {
  env: Record<string, string>;
  providers:
    | {
        active: string;
        configs: Record<string, { env_key?: string } & Record<string, unknown>>;
      }
    | null;
}

/**
 * Pull only the OMB-consumed subset out of an arbitrary parsed TOML blob.
 * Fields outside this whitelist are discarded (they are codex-only schema;
 * see migrator doc-comment at the top of this file).
 */
export function extractOmbOwnedFromLegacyToml(
  parsed: Record<string, unknown>,
): ExtractedOmbOwnedFields {
  const env: Record<string, string> = {};
  const rawEnv = parsed.env;
  if (isPlainObject(rawEnv)) {
    for (const [key, value] of Object.entries(rawEnv)) {
      const str = normalizeString(value);
      if (str !== undefined) env[key] = str;
    }
  }

  const activeProvider = normalizeString(parsed.model_provider);
  const rawProviders = parsed.model_providers;
  let providers: ExtractedOmbOwnedFields["providers"] = null;
  if (activeProvider && isPlainObject(rawProviders)) {
    const configs: Record<string, { env_key?: string } & Record<string, unknown>> = {};
    for (const [name, entryValue] of Object.entries(rawProviders)) {
      if (!isPlainObject(entryValue)) continue;
      const entry: { env_key?: string } & Record<string, unknown> = {};
      const envKey = normalizeString(entryValue.env_key);
      if (envKey) entry.env_key = envKey;
      // Preserve any other scalar subkeys (base_url, wire_api, ...) so a
      // re-migrated user doesn't silently lose per-provider fields even
      // though OMB only reads env_key today.
      for (const [subKey, subValue] of Object.entries(entryValue)) {
        if (subKey === "env_key") continue;
        if (typeof subValue === "string" || typeof subValue === "number" || typeof subValue === "boolean") {
          entry[subKey] = subValue;
        }
      }
      configs[name] = entry;
    }
    // Only emit the providers block if the active provider actually has a
    // config entry. Otherwise we would produce `{ active: "x", configs: {...} }`
    // where `configs["x"]` is missing, which makes the downstream JSON-first
    // read in src/config/models.ts short-circuit and silently skip the legacy
    // TOML fallback — silently dropping worker API-key env-override. (See
    // architect-review F3.)
    if (configs[activeProvider]) {
      providers = { active: activeProvider, configs };
    }
  }

  return { env, providers };
}

export async function migrateLegacyCodebuddyConfigToml(
  options: MigrateLegacyCodebuddyConfigOptions,
): Promise<MigrateLegacyCodebuddyConfigResult> {
  if (!existsSync(options.legacyConfigPath)) {
    return { noop: true, removedLegacy: false, wroteJson: false, carriedKeys: [] };
  }

  const raw = await readFile(options.legacyConfigPath, "utf-8");
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    // A corrupted TOML should not block setup. Warn, leave the file in
    // place, and let a future run retry once the user repairs or removes it.
    process.stderr.write(
      `[omb] warning: failed to parse legacy CodeBuddy config.toml for migration (${
        err instanceof Error ? err.message : String(err)
      }). Leaving ${options.legacyConfigPath} untouched.\n`,
    );
    return { noop: false, removedLegacy: false, wroteJson: false, carriedKeys: [] };
  }

  const extracted = extractOmbOwnedFromLegacyToml(parsed);
  const carriedKeys: string[] = [];
  if (Object.keys(extracted.env).length > 0) carriedKeys.push("env");
  if (extracted.providers) carriedKeys.push("providers");

  const homeDir = dirname(options.legacyConfigPath);
  const jsonPath = join(homeDir, OMB_MANAGED_CONFIG_BASENAME);

  let existingJson: Record<string, unknown> = {};
  if (existsSync(jsonPath)) {
    try {
      existingJson = JSON.parse(await readFile(jsonPath, "utf-8"));
      if (!isPlainObject(existingJson)) existingJson = {};
    } catch {
      existingJson = {};
    }
  }

  const merged: Record<string, unknown> = { ...existingJson };
  if (Object.keys(extracted.env).length > 0) {
    const existingEnv = isPlainObject(existingJson.env) ? { ...existingJson.env } : {};
    // JSON-side values win on conflict (existingJson was already the source
    // of truth under the new scheme); TOML fills in only missing keys.
    for (const [key, value] of Object.entries(extracted.env)) {
      if (!(key in existingEnv)) existingEnv[key] = value;
    }
    merged.env = existingEnv;
  }
  if (extracted.providers) {
    // Same precedence rule: existing JSON providers block wins; legacy TOML
    // only backfills. A pre-existing `active` is preserved.
    const existingProviders = isPlainObject(existingJson.providers)
      ? { ...existingJson.providers }
      : {};
    const existingConfigs = isPlainObject(existingProviders.configs)
      ? { ...existingProviders.configs }
      : {};
    for (const [name, entry] of Object.entries(extracted.providers.configs)) {
      if (!(name in existingConfigs)) existingConfigs[name] = entry;
    }
    existingProviders.configs = existingConfigs;
    if (typeof existingProviders.active !== "string" || existingProviders.active.trim() === "") {
      existingProviders.active = extracted.providers.active;
    }
    merged.providers = existingProviders;
  }

  // Post-merge invariant: if the merged `providers` block still has a
  // dangling `active` (e.g., a pre-F3 migration left a ghost pointer whose
  // config entry never existed), strip the whole block. The downstream
  // JSON-first read at src/config/models.ts short-circuits on a present
  // `providers` object; leaving a dangling shape would silently skip the
  // TOML fallback and drop worker API-key env overrides. Matches F3
  // semantics on re-migration paths. (architect-review R1.)
  if (isPlainObject(merged.providers)) {
    const providersBlock = merged.providers as {
      active?: unknown;
      configs?: Record<string, unknown>;
    };
    const activeName =
      typeof providersBlock.active === "string" ? providersBlock.active.trim() : "";
    const configs = isPlainObject(providersBlock.configs) ? providersBlock.configs : null;
    const hasMatchingConfig = Boolean(
      activeName && configs && configs[activeName] !== undefined,
    );
    if (!hasMatchingConfig) {
      delete merged.providers;
    }
  }

  const wouldWrite = carriedKeys.length > 0;
  if (!options.dryRun) {
    if (wouldWrite) {
      await mkdir(dirname(jsonPath), { recursive: true });
      await writeFile(jsonPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
    }
    await rm(options.legacyConfigPath, { force: true });
  }

  if (options.verbose || wouldWrite) {
    process.stderr.write(
      `[omb] ${options.dryRun ? "would migrate" : "migrated"} legacy CodeBuddy config.toml → ${OMB_MANAGED_CONFIG_BASENAME} (carried: ${carriedKeys.join(", ") || "none"}); ${options.dryRun ? "would remove" : "removed"} ${options.legacyConfigPath}\n`,
    );
  }

  return {
    noop: false,
    removedLegacy: true,
    wroteJson: wouldWrite,
    carriedKeys,
  };
}

/**
 * Ensure `{codebuddyHome}/.omb-config.json` exists after setup so that
 * `omb doctor` can tell "setup has run" apart from "fresh install with only
 * CodeBuddy-native settings.json". Seeds an `env` block with the defaults the
 * old TOML carried (so readConfigEnvValue finds them after setup), but
 * preserves any pre-existing fields untouched.
 */
export async function ensureOmbManagedConfig(options: {
  codebuddyHome: string;
  dryRun: boolean;
}): Promise<{ wrote: boolean; path: string }> {
  const jsonPath = join(options.codebuddyHome, OMB_MANAGED_CONFIG_BASENAME);
  let existing: Record<string, unknown> = {};
  if (existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(await readFile(jsonPath, "utf-8"));
      if (isPlainObject(parsed)) existing = parsed;
    } catch {
      existing = {};
    }
  }

  const envBlock = isPlainObject(existing.env) ? { ...existing.env } : {};
  let mutated = false;
  const seedDefaults: Record<string, string> = {
    USE_OMB_EXPLORE_CMD: "1",
    OMB_EXPERIMENTAL_COMMAND_TEMPLATES: "0",
  };
  for (const [key, defaultValue] of Object.entries(seedDefaults)) {
    if (!(key in envBlock)) {
      envBlock[key] = defaultValue;
      mutated = true;
    }
  }

  const next: Record<string, unknown> = { ...existing };
  if (mutated || !isPlainObject(existing.env)) {
    next.env = envBlock;
    mutated = true;
  }

  if (!mutated && existsSync(jsonPath)) {
    return { wrote: false, path: jsonPath };
  }

  if (!options.dryRun) {
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  }
  return { wrote: true, path: jsonPath };
}
