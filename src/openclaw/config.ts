/**
 * OpenClaw Configuration Reader
 *
 * Reads OpenClaw config from the notifications.openclaw key in ~/.codex/.omb-config.json.
 * Also supports generic alias shapes under notifications.custom_cli_command
 * and notifications.custom_webhook_command, normalized to OpenClaw runtime config.
 *
 * Config is cached after first read (env vars don't change during process lifetime).
 * Config file path can be overridden via OMB_OPENCLAW_CONFIG / OMB_OPENCLAW_CONFIG env var (points to a separate file).
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { codebuddyHome } from "../utils/paths.js";
import type {
  OpenClawConfig,
  OpenClawHookEvent,
  OpenClawGatewayConfig,
  OpenClawCommandGatewayConfig,
  OpenClawHookMapping,
} from "./types.js";

/** Cached config (null = not yet read, undefined = read but file missing/invalid) */
let _cachedConfig: OpenClawConfig | undefined | null = null;

const VALID_HOOK_EVENTS: OpenClawHookEvent[] = [
  "session-start",
  "session-end",
  "session-idle",
  "ask-user-question",
  "stop",
];

const DEFAULT_ALIAS_EVENTS: OpenClawHookEvent[] = ["session-end", "ask-user-question"];

function resolveNotificationConfigPath(): string {
  const home = codebuddyHome();
  const canonical = join(home, ".omb-config.json");
  if (existsSync(canonical)) return canonical;
  return join(home, ".omb-config.json");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseEvents(value: unknown): OpenClawHookEvent[] {
  if (!Array.isArray(value)) return [...DEFAULT_ALIAS_EVENTS];
  const events = value
    .filter((entry): entry is OpenClawHookEvent =>
      typeof entry === "string" && VALID_HOOK_EVENTS.includes(entry as OpenClawHookEvent),
    );
  return events.length > 0 ? events : [...DEFAULT_ALIAS_EVENTS];
}

function parseInstruction(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeFromCustomAliases(notifications: Record<string, unknown>): OpenClawConfig | null {
  const webhookAlias = asRecord(notifications.custom_webhook_command);
  const cliAlias = asRecord(notifications.custom_cli_command);

  const webhookEnabled = webhookAlias?.enabled !== false && typeof webhookAlias?.url === "string";
  const cliEnabled = cliAlias?.enabled !== false && typeof cliAlias?.command === "string";

  if (!webhookEnabled && !cliEnabled) return null;

  const gateways: Record<string, OpenClawGatewayConfig> = {};
  const hooks: Partial<Record<OpenClawHookEvent, OpenClawHookMapping>> = {};

  const applyHooks = (events: OpenClawHookEvent[], gateway: string, instruction: string, source: string): void => {
    for (const event of events) {
      if (hooks[event]) {
        console.warn(`[openclaw] warning: ${source} overrides existing mapping for event '${event}'`);
      }
      hooks[event] = {
        enabled: true,
        gateway,
        instruction,
      };
    }
  };

  if (cliEnabled && cliAlias) {
    const gatewayName =
      typeof cliAlias.gateway === "string" && cliAlias.gateway.trim()
        ? cliAlias.gateway.trim()
        : "custom-cli";

    gateways[gatewayName] = {
      type: "command",
      command: (cliAlias.command as string).trim(),
      ...(typeof cliAlias.timeout === "number" ? { timeout: cliAlias.timeout } : {}),
    } as OpenClawCommandGatewayConfig;

    applyHooks(
      parseEvents(cliAlias.events),
      gatewayName,
      parseInstruction(
        cliAlias.instruction,
        "OMB event {{event}} for {{projectPath}}",
      ),
      "custom_cli_command",
    );
  }

  if (webhookEnabled && webhookAlias) {
    const gatewayName =
      typeof webhookAlias.gateway === "string" && webhookAlias.gateway.trim()
        ? webhookAlias.gateway.trim()
        : "custom-webhook";

    const method = webhookAlias.method === "PUT" ? "PUT" : "POST";

    gateways[gatewayName] = {
      type: "http",
      url: (webhookAlias.url as string).trim(),
      method,
      ...(typeof webhookAlias.timeout === "number" ? { timeout: webhookAlias.timeout } : {}),
      ...(asRecord(webhookAlias.headers) ? { headers: webhookAlias.headers as Record<string, string> } : {}),
    };

    applyHooks(
      parseEvents(webhookAlias.events),
      gatewayName,
      parseInstruction(
        webhookAlias.instruction,
        "OMB event {{event}} for {{projectPath}}",
      ),
      "custom_webhook_command",
    );
  }

  if (Object.keys(gateways).length === 0 || Object.keys(hooks).length === 0) return null;

  return {
    enabled: true,
    gateways,
    hooks,
  };
}

function isValidOpenClawConfig(raw: OpenClawConfig | undefined): raw is OpenClawConfig {
  return Boolean(raw?.enabled && raw.gateways && raw.hooks);
}

type OpenClawAliasSource = "custom_cli_command" | "custom_webhook_command";

export interface OpenClawConfigInspection {
  state: "configured" | "disabled" | "missing-config" | "invalid-config" | "not-configured";
  activationGateEnabled: boolean;
  commandGateEnabled: boolean;
  configPath: string;
  configExists: boolean;
  configSource: "env-override" | "notifications.openclaw" | "custom-aliases" | null;
  explicitConfigPresent: boolean;
  aliasConfigPresent: boolean;
  aliasSources: OpenClawAliasSource[];
  explicitOverridesAliases: boolean;
  warnings: string[];
  detail: string;
  config: OpenClawConfig | null;
}

function inspectCustomAliases(notifications: Record<string, unknown>): {
  config: OpenClawConfig | null;
  sources: OpenClawAliasSource[];
} {
  const webhookAlias = asRecord(notifications.custom_webhook_command);
  const cliAlias = asRecord(notifications.custom_cli_command);
  const sources: OpenClawAliasSource[] = [];

  const webhookEnabled = webhookAlias?.enabled !== false && typeof webhookAlias?.url === "string";
  const cliEnabled = cliAlias?.enabled !== false && typeof cliAlias?.command === "string";

  if (!webhookEnabled && !cliEnabled) return { config: null, sources };

  const gateways: Record<string, OpenClawGatewayConfig> = {};
  const hooks: Partial<Record<OpenClawHookEvent, OpenClawHookMapping>> = {};

  const applyHooks = (events: OpenClawHookEvent[], gateway: string, instruction: string, source: OpenClawAliasSource): void => {
    sources.push(source);
    for (const event of events) {
      hooks[event] = {
        enabled: true,
        gateway,
        instruction,
      };
    }
  };

  if (cliEnabled && cliAlias) {
    const gatewayName =
      typeof cliAlias.gateway === "string" && cliAlias.gateway.trim()
        ? cliAlias.gateway.trim()
        : "custom-cli";

    gateways[gatewayName] = {
      type: "command",
      command: (cliAlias.command as string).trim(),
      ...(typeof cliAlias.timeout === "number" ? { timeout: cliAlias.timeout } : {}),
    } as OpenClawCommandGatewayConfig;

    applyHooks(
      parseEvents(cliAlias.events),
      gatewayName,
      parseInstruction(
        cliAlias.instruction,
        "OMB event {{event}} for {{projectPath}}",
      ),
      "custom_cli_command",
    );
  }

  if (webhookEnabled && webhookAlias) {
    const gatewayName =
      typeof webhookAlias.gateway === "string" && webhookAlias.gateway.trim()
        ? webhookAlias.gateway.trim()
        : "custom-webhook";

    const method = webhookAlias.method === "PUT" ? "PUT" : "POST";

    gateways[gatewayName] = {
      type: "http",
      url: (webhookAlias.url as string).trim(),
      method,
      ...(typeof webhookAlias.timeout === "number" ? { timeout: webhookAlias.timeout } : {}),
      ...(asRecord(webhookAlias.headers) ? { headers: webhookAlias.headers as Record<string, string> } : {}),
    };

    applyHooks(
      parseEvents(webhookAlias.events),
      gatewayName,
      parseInstruction(
        webhookAlias.instruction,
        "OMB event {{event}} for {{projectPath}}",
      ),
      "custom_webhook_command",
    );
  }

  if (Object.keys(gateways).length === 0 || Object.keys(hooks).length === 0) {
    return { config: null, sources };
  }

  return {
    config: {
      enabled: true,
      gateways,
      hooks,
    },
    sources: [...new Set(sources)],
  };
}

export function inspectOpenClawConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfigInspection {
  const activationGateEnabled = (env.OMB_OPENCLAW ?? env.OMB_OPENCLAW) === "1";
  const commandGateEnabled = (env.OMB_OPENCLAW_COMMAND ?? env.OMB_OPENCLAW_COMMAND) === "1";
  const envOverride = (env.OMB_OPENCLAW_CONFIG ?? env.OMB_OPENCLAW_CONFIG)?.trim();
  const configPath = envOverride || resolveNotificationConfigPath();
  const configExists = existsSync(configPath);

  if (!activationGateEnabled) {
    return {
      state: "disabled",
      activationGateEnabled,
      commandGateEnabled,
      configPath,
      configExists,
      configSource: null,
      explicitConfigPresent: false,
      aliasConfigPresent: false,
      aliasSources: [],
      explicitOverridesAliases: false,
      warnings: [],
      detail: "OpenClaw is disabled locally because OMB_OPENCLAW=1 is not set.",
      config: null,
    };
  }

  if (!configExists) {
    return {
      state: "missing-config",
      activationGateEnabled,
      commandGateEnabled,
      configPath,
      configExists,
      configSource: null,
      explicitConfigPresent: false,
      aliasConfigPresent: false,
      aliasSources: [],
      explicitOverridesAliases: false,
      warnings: [],
      detail: envOverride
        ? `OMB_OPENCLAW_CONFIG points to ${configPath}, but the file does not exist.`
        : `No OpenClaw config file was found at ${configPath}.`,
      config: null,
    };
  }

  try {
    if (envOverride) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8")) as OpenClawConfig;
      if (!isValidOpenClawConfig(raw)) {
        return {
          state: "invalid-config",
          activationGateEnabled,
          commandGateEnabled,
          configPath,
          configExists,
          configSource: null,
          explicitConfigPresent: false,
          aliasConfigPresent: false,
          aliasSources: [],
          explicitOverridesAliases: false,
          warnings: [],
          detail:
            "OMB_OPENCLAW_CONFIG is present but does not contain a valid OpenClaw config.",
          config: null,
        };
      }

      return {
        state: "configured",
        activationGateEnabled,
        commandGateEnabled,
        configPath,
        configExists,
        configSource: "env-override",
        explicitConfigPresent: false,
        aliasConfigPresent: false,
        aliasSources: [],
        explicitOverridesAliases: false,
        warnings: [],
        detail: "OpenClaw config loaded from OMB_OPENCLAW_CONFIG.",
        config: raw,
      };
    }

    const fullConfig = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const notifications = asRecord(fullConfig.notifications);
    if (!notifications) {
      return {
        state: "not-configured",
        activationGateEnabled,
        commandGateEnabled,
        configPath,
        configExists,
        configSource: null,
        explicitConfigPresent: false,
        aliasConfigPresent: false,
        aliasSources: [],
        explicitOverridesAliases: false,
        warnings: [],
        detail:
          "The OMB config file exists, but notifications are not configured.",
        config: null,
      };
    }

    const explicitOpenClaw = notifications.openclaw as OpenClawConfig | undefined;
    const explicitConfigPresent = explicitOpenClaw !== undefined;
    const aliasInspection = inspectCustomAliases(notifications);
    const aliasConfigPresent = aliasInspection.config !== null;

    if (isValidOpenClawConfig(explicitOpenClaw)) {
      const explicitOverridesAliases = aliasInspection.config !== null;
      return {
        state: "configured",
        activationGateEnabled,
        commandGateEnabled,
        configPath,
        configExists,
        configSource: "notifications.openclaw",
        explicitConfigPresent,
        aliasConfigPresent,
        aliasSources: aliasInspection.sources,
        explicitOverridesAliases,
        warnings: explicitOverridesAliases
          ? [
              "notifications.openclaw overrides custom_cli_command/custom_webhook_command aliases.",
            ]
          : [],
        detail: "OpenClaw config loaded from notifications.openclaw.",
        config: explicitOpenClaw,
      };
    }

    if (aliasInspection.config) {
      return {
        state: "configured",
        activationGateEnabled,
        commandGateEnabled,
        configPath,
        configExists,
        configSource: "custom-aliases",
        explicitConfigPresent,
        aliasConfigPresent,
        aliasSources: aliasInspection.sources,
        explicitOverridesAliases: false,
        warnings: [],
        detail: "OpenClaw config synthesized from custom notification aliases.",
        config: aliasInspection.config,
      };
    }

    return {
      state: "invalid-config",
      activationGateEnabled,
      commandGateEnabled,
      configPath,
      configExists,
      configSource: null,
      explicitConfigPresent,
      aliasConfigPresent,
      aliasSources: aliasInspection.sources,
      explicitOverridesAliases: false,
      warnings: [],
      detail:
        "OpenClaw config keys are present but do not form a valid runtime config.",
      config: null,
    };
  } catch {
    return {
      state: "invalid-config",
      activationGateEnabled,
      commandGateEnabled,
      configPath,
      configExists,
      configSource: null,
      explicitConfigPresent: false,
      aliasConfigPresent: false,
      aliasSources: [],
      explicitOverridesAliases: false,
      warnings: [],
      detail: "OpenClaw config could not be parsed as valid JSON.",
      config: null,
    };
  }
}

/**
 * Read and cache the OpenClaw configuration.
 *
 * Returns null when:
 * - OMB_OPENCLAW / OMB_OPENCLAW env var is not "1"
 * - Config file does not exist
 * - Config file is invalid JSON
 * - Config has enabled: false
 *
 * Config is read from:
 * 1. OMB_OPENCLAW_CONFIG / OMB_OPENCLAW_CONFIG env var path (separate file), if set
 * 2. notifications.openclaw key in ~/.codex/.omb-config.json
 * 3. notifications.custom_cli_command / notifications.custom_webhook_command aliases
 */
export function getOpenClawConfig(): OpenClawConfig | null {
  // Activation gate: only active when OMB_OPENCLAW=1
  if ((process.env.OMB_OPENCLAW) !== "1") {
    return null;
  }

  // Return cached result
  if (_cachedConfig !== null) {
    return _cachedConfig ?? null;
  }

  try {
    const envOverride = process.env.OMB_OPENCLAW_CONFIG;

    if (envOverride) {
      // OMB_OPENCLAW_CONFIG points to a separate config file
      if (!existsSync(envOverride)) {
        _cachedConfig = undefined;
        return null;
      }
      const raw = JSON.parse(readFileSync(envOverride, "utf-8")) as OpenClawConfig;
      if (!isValidOpenClawConfig(raw)) {
        _cachedConfig = undefined;
        return null;
      }
      _cachedConfig = raw;
      return raw;
    }

    // Primary: read from notifications block in .omb-config.json
    const ombConfigPath = resolveNotificationConfigPath();
    if (!existsSync(ombConfigPath)) {
      _cachedConfig = undefined;
      return null;
    }

    const fullConfig = JSON.parse(readFileSync(ombConfigPath, "utf-8")) as Record<string, unknown>;
    const notifications = asRecord(fullConfig.notifications);
    if (!notifications) {
      _cachedConfig = undefined;
      return null;
    }

    const explicitOpenClaw = notifications.openclaw as OpenClawConfig | undefined;
    const aliasOpenClaw = normalizeFromCustomAliases(notifications);

    if (isValidOpenClawConfig(explicitOpenClaw)) {
      if (aliasOpenClaw) {
        console.warn(
          "[openclaw] warning: notifications.openclaw is set; ignoring custom_cli_command/custom_webhook_command aliases",
        );
      }
      _cachedConfig = explicitOpenClaw;
      return explicitOpenClaw;
    }

    if (aliasOpenClaw) {
      _cachedConfig = aliasOpenClaw;
      return aliasOpenClaw;
    }

    _cachedConfig = undefined;
    return null;
  } catch {
    _cachedConfig = undefined;
    return null;
  }
}

/**
 * Resolve gateway config for a specific hook event.
 * Returns null if the event is not mapped or disabled.
 * Returns the gateway name alongside config to avoid O(n) reverse lookup.
 */
export function resolveGateway(
  config: OpenClawConfig,
  event: OpenClawHookEvent,
): { gatewayName: string; gateway: OpenClawGatewayConfig; instruction: string } | null {
  const mapping = config.hooks[event];
  if (!mapping || !mapping.enabled) {
    return null;
  }

  const gateway = config.gateways[mapping.gateway];
  if (!gateway) {
    return null;
  }

  // Validate based on gateway type
  if ((gateway as OpenClawCommandGatewayConfig).type === "command") {
    if (!(gateway as OpenClawCommandGatewayConfig).command) return null;
  } else {
    // HTTP gateway (default when type is absent or "http")
    if (!("url" in gateway) || !gateway.url) return null;
  }

  return { gatewayName: mapping.gateway, gateway, instruction: mapping.instruction };
}

/**
 * Reset the config cache (for testing only).
 */
export function resetOpenClawConfigCache(): void {
  _cachedConfig = null;
}
