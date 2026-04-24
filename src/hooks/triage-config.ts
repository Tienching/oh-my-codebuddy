/**
 * Triage Feature Gate Config Reader
 *
 * Reads promptRouting.triage.enabled from codebuddyHome()/.omb-config.json.
 * Defaults to enabled when the config file is absent or the triage flag is
 * omitted from an otherwise valid config object (rollout default).
 * Fails closed (enabled: false) when the file exists but is malformed.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { codebuddyHome } from "../utils/paths.js";

export type TriageConfigStatus = "enabled" | "disabled" | "defaulted" | "invalid";

export interface TriageConfig {
  enabled: boolean;
  status: TriageConfigStatus;
  source: "default" | "file" | "invalid";
  path: string;
}

/** Cached triage config. `undefined` = not yet read. */
let cachedTriageConfig: TriageConfig | undefined;

export function readTriageConfig(): TriageConfig {
  if (cachedTriageConfig !== undefined) return cachedTriageConfig;

  const path = join(codebuddyHome(), ".omb-config.json");

  if (!existsSync(path)) {
    cachedTriageConfig = { enabled: true, status: "defaulted", source: "default", path };
    return cachedTriageConfig;
  }

  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      cachedTriageConfig = { enabled: false, status: "invalid", source: "invalid", path };
      return cachedTriageConfig;
    }

    const root = raw as Record<string, unknown>;
    const promptRouting = root["promptRouting"];
    if (promptRouting === undefined) {
      cachedTriageConfig = { enabled: true, status: "defaulted", source: "default", path };
      return cachedTriageConfig;
    }
    if (!promptRouting || typeof promptRouting !== "object" || Array.isArray(promptRouting)) {
      cachedTriageConfig = { enabled: false, status: "invalid", source: "invalid", path };
      return cachedTriageConfig;
    }

    const triage = (promptRouting as Record<string, unknown>)["triage"];
    if (triage === undefined) {
      cachedTriageConfig = { enabled: true, status: "defaulted", source: "default", path };
      return cachedTriageConfig;
    }
    if (!triage || typeof triage !== "object" || Array.isArray(triage)) {
      cachedTriageConfig = { enabled: false, status: "invalid", source: "invalid", path };
      return cachedTriageConfig;
    }

    const triageEnabled = (triage as Record<string, unknown>)["enabled"];
    if (triageEnabled === undefined) {
      cachedTriageConfig = { enabled: true, status: "defaulted", source: "default", path };
      return cachedTriageConfig;
    }
    if (typeof triageEnabled !== "boolean") {
      cachedTriageConfig = { enabled: false, status: "invalid", source: "invalid", path };
      return cachedTriageConfig;
    }

    cachedTriageConfig = {
      enabled: triageEnabled,
      status: triageEnabled ? "enabled" : "disabled",
      source: "file",
      path,
    };
    return cachedTriageConfig;
  } catch {
    cachedTriageConfig = { enabled: false, status: "invalid", source: "invalid", path };
    return cachedTriageConfig;
  }
}

export function resetTriageConfigCache(): void {
  cachedTriageConfig = undefined;
}
