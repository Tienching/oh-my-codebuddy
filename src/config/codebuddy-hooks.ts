import { join } from "path";

const MANAGED_HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
] as const;

type ManagedHookEventName = (typeof MANAGED_HOOK_EVENTS)[number];

type JsonObject = Record<string, unknown>;

export interface ManagedCodebuddyHooksConfig {
  hooks: Record<ManagedHookEventName, Array<Record<string, unknown>>>;
}

export type ManagedCodexHooksConfig = ManagedCodebuddyHooksConfig;

interface ParsedCodebuddyHooksConfig {
  root: JsonObject;
  hooks: JsonObject;
}

export interface RemoveManagedCodebuddyHooksResult {
  nextContent: string | null;
  removedCount: number;
}

export type RemoveManagedCodexHooksResult = RemoveManagedCodebuddyHooksResult;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function buildCommandHook(
  command: string,
  options: {
    matcher?: string;
    statusMessage?: string;
    timeout?: number;
  } = {},
): Record<string, unknown> {
  const hook = {
    type: "command",
    command,
    ...(options.statusMessage ? { statusMessage: options.statusMessage } : {}),
    ...(typeof options.timeout === "number" ? { timeout: options.timeout } : {}),
  };

  return {
    ...(options.matcher ? { matcher: options.matcher } : {}),
    hooks: [hook],
  };
}

export function buildManagedCodebuddyHooksConfig(
  pkgRoot: string,
): ManagedCodebuddyHooksConfig {
  const hookScript = join(pkgRoot, "dist", "scripts", "codebuddy-native-hook.js");
  const command = `node "${hookScript}"`;

  return {
    hooks: {
      SessionStart: [
        buildCommandHook(command, {
          matcher: "startup|resume",
          statusMessage: "Loading OMB session context",
        }),
      ],
      PreToolUse: [
        buildCommandHook(command, {
          matcher: "Bash",
          statusMessage: "Running OMB Bash preflight",
        }),
      ],
      PostToolUse: [
        buildCommandHook(command, {
          statusMessage: "Running OMB tool review",
        }),
      ],
      UserPromptSubmit: [
        buildCommandHook(command, {
          statusMessage: "Applying OMB prompt routing",
        }),
      ],
      Stop: [
        buildCommandHook(command, {
          timeout: 30,
        }),
      ],
    },
  };
}

export const buildManagedCodexHooksConfig = buildManagedCodebuddyHooksConfig;

export function parseCodebuddyHooksConfig(
  content: string,
): ParsedCodebuddyHooksConfig | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed)) return null;

    return {
      root: cloneJson(parsed),
      hooks: isPlainObject(parsed.hooks) ? cloneJson(parsed.hooks) : {},
    };
  } catch {
    return null;
  }
}

export const parseCodexHooksConfig = parseCodebuddyHooksConfig;

function isManagedHookCommand(command: string): boolean {
  return /(?:^|[\\/])(?:codebuddy|codex)-native-hook\.js(?:["'\s]|$)/.test(
    command,
  );
}

function stripManagedHooksFromEntry(entry: unknown): {
  entry: unknown | null;
  removedCount: number;
} {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
    return { entry: cloneJson(entry), removedCount: 0 };
  }

  const nextHooks = entry.hooks.filter((hook) => {
    if (!isPlainObject(hook)) return true;
    return !(
      hook.type === "command" &&
      typeof hook.command === "string" &&
      isManagedHookCommand(hook.command)
    );
  });

  const removedCount = entry.hooks.length - nextHooks.length;
  if (removedCount === 0) {
    return { entry: cloneJson(entry), removedCount: 0 };
  }

  if (nextHooks.length === 0) {
    return { entry: null, removedCount };
  }

  return {
    entry: {
      ...cloneJson(entry),
      hooks: nextHooks,
    },
    removedCount,
  };
}

function serializeCodebuddyHooksConfig(root: JsonObject): string {
  return JSON.stringify(root, null, 2) + "\n";
}

export function mergeManagedCodebuddyHooksConfig(
  existingContent: string | null | undefined,
  pkgRoot: string,
): string {
  const managedConfig = buildManagedCodebuddyHooksConfig(pkgRoot);
  const parsed =
    typeof existingContent === "string"
      ? parseCodebuddyHooksConfig(existingContent)
      : null;

  const nextRoot = parsed ? cloneJson(parsed.root) : {};
  const nextHooks = parsed ? cloneJson(parsed.hooks) : {};

  for (const eventName of MANAGED_HOOK_EVENTS) {
    const existingEntries = Array.isArray(nextHooks[eventName])
      ? nextHooks[eventName]
      : [];
    const preservedEntries: unknown[] = [];

    for (const entry of existingEntries) {
      const stripped = stripManagedHooksFromEntry(entry);
      if (stripped.entry !== null) {
        preservedEntries.push(stripped.entry);
      }
    }

    nextHooks[eventName] = [
      ...preservedEntries,
      ...managedConfig.hooks[eventName].map((entry) => cloneJson(entry)),
    ];
  }

  if (Object.keys(nextHooks).length > 0) {
    nextRoot.hooks = nextHooks;
  } else {
    delete nextRoot.hooks;
  }

  return serializeCodebuddyHooksConfig(nextRoot);
}

export const mergeManagedCodexHooksConfig = mergeManagedCodebuddyHooksConfig;

export function removeManagedCodebuddyHooks(
  existingContent: string,
): RemoveManagedCodebuddyHooksResult {
  const parsed = parseCodebuddyHooksConfig(existingContent);
  if (!parsed) {
    return { nextContent: existingContent, removedCount: 0 };
  }

  const nextRoot = cloneJson(parsed.root);
  const nextHooks = cloneJson(parsed.hooks);
  let removedCount = 0;

  for (const [eventName, rawEntries] of Object.entries(nextHooks)) {
    if (!Array.isArray(rawEntries)) continue;

    const preservedEntries: unknown[] = [];
    for (const entry of rawEntries) {
      const stripped = stripManagedHooksFromEntry(entry);
      removedCount += stripped.removedCount;
      if (stripped.entry !== null) {
        preservedEntries.push(stripped.entry);
      }
    }

    if (preservedEntries.length > 0) {
      nextHooks[eventName] = preservedEntries;
    } else {
      delete nextHooks[eventName];
    }
  }

  if (removedCount === 0) {
    return { nextContent: existingContent, removedCount: 0 };
  }

  if (Object.keys(nextHooks).length > 0) {
    nextRoot.hooks = nextHooks;
  } else {
    delete nextRoot.hooks;
  }

  if (Object.keys(nextRoot).length === 0) {
    return { nextContent: null, removedCount };
  }

  return {
    nextContent: serializeCodebuddyHooksConfig(nextRoot),
    removedCount,
  };
}

export const removeManagedCodexHooks = removeManagedCodebuddyHooks;
