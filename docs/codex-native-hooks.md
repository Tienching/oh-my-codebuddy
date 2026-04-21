# CodeBuddy native hook mapping

This page is the canonical answer to:

> Which OMB/legacy compatibility hooks run on native CodeBuddy hooks already, which stay on runtime fallbacks, and which are not supported yet?

## Install surface

`omb setup` now owns both of these native hook artifacts in the resolved CodeBuddy home:

- `config.toml` (`.codebuddy/config.toml` primary, legacy `.codex/config.toml` compatible) → enables `[features].codex_hooks = true`
- `hooks.json` (`.codebuddy/hooks.json` primary, legacy `.codex/hooks.json` compatible) → registers the OMB-managed native hook command while preserving non-OMB hook entries already in the file

For project scope, `.gitignore` keeps generated hook state out of source control.
`omb uninstall` removes only the OMB-managed wrapper entries from `hooks.json`; if user hooks remain, the file stays in place.

## Ownership split

- **Native CodeBuddy hooks**: `CODEBUDDY_HOME/hooks.json` (`.codebuddy` primary, `.codex` compatible)
- **OMB plugin hooks**: `.omb/hooks/*.mjs`
- **tmux/runtime fallbacks**: `omb tmux-hook`, notify-hook, derived watcher, idle/session-end reporters

OMB only owns the wrapper entries that invoke `dist/scripts/codebuddy-native-hook.js`; uninstall also cleans up legacy `codex-native-hook.js` wrappers for compatibility. User-managed hook entries in the same `hooks.json` file are preserved across `omb setup` refreshes and `omb uninstall`.

## Mapping matrix

| OMB / legacy compatibility surface | Native CodeBuddy source | OMB runtime target | Status | Notes |
| --- | --- | --- | --- | --- |
| `session-start` | `SessionStart` | `session-start` | native | Native adapter refreshes session bookkeeping, restores startup developer context, and ensures `.omb/` is gitignored at the repo root |
| `keyword-detector` | `UserPromptSubmit` | `keyword-detector` | native | Persists skill activation state and can add prompt-side developer context |
| `pre-tool-use` | `PreToolUse` (`Bash`) | `pre-tool-use` | native-partial | Current native scope is Bash-only; built-in native behavior is a narrow destructive-command caution via `systemMessage` |
| `post-tool-use` | `PostToolUse` (`Bash`) | `post-tool-use` | native-partial | Current native scope is Bash-only; built-in native behavior covers command-not-found / permission-denied / missing-path guidance and informative non-zero-output review |
| Ralph/persistence stop handling | `Stop` | `stop` | native-partial | Native adapter uses the documented native Stop continuation contract (`decision: "block"` + `reason`) for active Ralph runs and avoids re-blocking once `stop_hook_active` is set |
| Autopilot continuation | `Stop` | `stop` | native-partial | Native adapter continues non-terminal autopilot sessions from active session/root mode state |
| Ultrawork continuation | `Stop` | `stop` | native-partial | Native adapter continues non-terminal ultrawork sessions from active session/root mode state |
| UltraQA continuation | `Stop` | `stop` | native-partial | Native adapter continues non-terminal ultraqa sessions from active session/root mode state |
| Team-phase continuation | `Stop` | `stop` | native-partial | Native adapter treats per-team `phase.json` as canonical when deciding whether a current-session team run is still non-terminal and can re-block on later fresh Stop replies while keeping leader guidance explicit about rewriting system-generated worker auto-checkpoint commits into Lore-format final history |
| `ralplan` skill-state continuation | `Stop` | `stop` | native-partial | Native adapter can block on active `skill-active-state.json` for `ralplan`, unless active subagents are already the real in-flight owners |
| `deep-interview` skill-state continuation | `Stop` | `stop` | native-partial | Native adapter can block on active `skill-active-state.json` for `deep-interview`, unless active subagents are already the real in-flight owners |
| auto-nudge continuation | `Stop` | `stop` | native-partial | Native adapter continues turns that end in a permission/stall prompt, can re-fire for later fresh replies, and suppresses auto-nudge while interview / deep-interview state is active |
| `ask-user-question` | none | runtime-only | runtime-fallback | No distinct Codex native hook today |
| `PostToolUseFailure` | none | runtime-only | runtime-fallback | Fold into runtime/fallback handling until native support exists |
| non-Bash tool interception | none | runtime-only | runtime-fallback | Current Codex native tool hooks expose Bash only |
| code simplifier stop follow-up | none | runtime-only | runtime-fallback | Cleanup follow-up stays on runtime/fallback surfaces, not native Stop |
| `SubagentStop` | none | runtime-only | not-supported-yet | OMB-specific lifecycle extension |
| `session-end` | none | `session-end` | runtime-fallback | Still emitted from runtime/notify path, not native CodeBuddy hooks |
| `session-idle` | none | `session-idle` | runtime-fallback | Still emitted from runtime/notify path, not native CodeBuddy hooks |

## Verification guidance

When validating hooks, keep the proof boundary explicit:

1. **Native CodeBuddy hook proof**
   - `omb setup` wrote the resolved `hooks.json` in the CodeBuddy home (`.codebuddy` primary, `.codex` compatibility alias)
   - native hook execution invoked `dist/scripts/codebuddy-native-hook.js`
2. **OMB plugin proof**
   - plugin dispatch/log evidence exists under `.omb/logs/hooks-*.jsonl`
3. **Fallback proof**
   - behavior came from notify-hook / derived watcher / tmux runtime, not native CodeBuddy hooks

Do not claim “native hooks work” when only tmux or synthetic notify fallback paths were exercised.
