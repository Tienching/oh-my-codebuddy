# Hooks Extension (Custom Plugins)

OMB supports an additive hooks extension point for user plugins under `.omb/hooks/*.mjs`.

Native CodeBuddy hook ownership is documented separately in
[CodeBuddy native hook mapping](./codex-native-hooks.md). In short:

- `CODEBUDDY_HOME/hooks.json` (`.codebuddy` primary, `.codex` compatibility alias) = native CodeBuddy hook registrations installed by `omb setup`
- `.omb/hooks/*.mjs` = OMB plugin hooks dispatched by runtime/native events
- `omb tmux-hook` / notify-hook / derived watcher = tmux/runtime fallback surfaces

`omb setup` treats `hooks.json` as a shared-ownership file: it refreshes only the OMB-managed
wrapper entries that invoke `dist/scripts/codebuddy-native-hook.js` and preserves user hook entries in the
same file. `omb uninstall` removes only those OMB-managed wrappers (plus legacy `codex-native-hook.js`
wrappers for compatibility) and leaves `hooks.json` in place when user hooks remain.

> Compatibility guarantee: `omb tmux-hook` remains fully supported and unchanged.
> The new `omb hooks` command group is additive and does **not** replace tmux-hook workflows.

## Quick start

```bash
omb hooks init
omb hooks status
omb hooks validate
omb hooks test
```

This creates a scaffold plugin at:

- `.omb/hooks/sample-plugin.mjs`

## Enablement model

Plugins are **enabled by default**.

Disable plugin dispatch explicitly:

```bash
export OMB_HOOK_PLUGINS=0
```

Optional timeout tuning (default: 1500ms):

```bash
export OMB_HOOK_PLUGIN_TIMEOUT_MS=1500
```

## Native event pipeline (v1)

Native/derived plugin events come from two places:

1. Existing lifecycle/notify paths
2. Native CodeBuddy hook entrypoint dispatch (`dist/scripts/codebuddy-native-hook.js`)

Current event vocabulary exposed to OMB plugins:

- `session-start`
- `keyword-detector`
- `pre-tool-use`
- `post-tool-use`
- `stop`
- `session-end`
- `turn-complete`
- `session-idle`

OMB keeps this existing event vocabulary rather than exposing raw hook event names directly.
That lets native CodeBuddy hooks and fallback/derived paths feed one shared plugin/runtime surface.

For clawhip-oriented operational routing, see [Clawhip Event Contract](./clawhip-event-contract.md).

Envelope fields include:

- `schema_version: "1"`
- `event`
- `timestamp`
- `source` (`native` or `derived`)
- `context`
- optional IDs: `session_id`, `thread_id`, `turn_id`, `mode`

## Derived signals (opt-in)

Best-effort derived events are gated and disabled by default.

```bash
export OMB_HOOK_DERIVED_SIGNALS=1
```

Derived signals include:

- `needs-input`
- `pre-tool-use`
- `post-tool-use`

Derived events are labeled with:

- `source: "derived"`
- `confidence`
- parser-specific context hints

## Team-safety behavior

In team-worker sessions (`OMB_TEAM_WORKER` set), plugin side effects are skipped by default.
This keeps the lead session as the canonical side-effect emitter and avoids duplicate sends.

## Plugin contract

Each plugin must export:

```js
export async function onHookEvent(event, sdk) {
  // handle event
}
```

SDK surface includes:

- `sdk.tmux.sendKeys(...)`
- `sdk.log.info|warn|error(...)`
- `sdk.state.read|write|delete|all(...)` (plugin namespace scoped)
- `sdk.omb.session.read()`
- `sdk.omb.hud.read()`
- `sdk.omb.notifyFallback.read()`
- `sdk.omb.updateCheck.read()`

`sdk.omb` is intentionally narrow and read-only in pass one. These helpers read the
repo-root `.omb/state/*.json` runtime files for the current workspace.

Compatibility notes:

- `omb tmux-hook` remains a CLI/runtime workflow, not `sdk.omb.tmuxHook.*`
- pass one does not add `sdk.omb.tmuxHook.*`; tmux plugin behavior stays on `sdk.tmux.sendKeys(...)`
- pass one does not add generic `sdk.omb.readJson(...)`, `sdk.omb.list()`, or `sdk.omb.exists()`
- pass one does not add `sdk.pluginState`; keep using `sdk.state`

## Logs

Plugin dispatch and plugin logs are written to:

- `.omb/logs/hooks-YYYY-MM-DD.jsonl`
