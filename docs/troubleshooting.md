# Troubleshooting execution readiness

Use this page when OMB appears installed but real CodeBuddy/Codex execution still fails.

## Install success vs real execution success

`omb setup` and `omb doctor` validate OMB's local install surface: prompts, skills, AGENTS scaffolding, config files, hooks, and runtime prerequisites. They do not guarantee that the active CodeBuddy/Codex profile can authenticate and complete a model request.

After `omb doctor`, run a real smoke test from the same shell, HOME, and project directory you will use for OMB:

```bash
codex login status
omb exec --skip-git-repo-check -C . "Reply with exactly OMB-EXEC-OK"
```

Treat the boundary this way:

- `omb doctor` green: install and local runtime wiring look sane.
- `codex login status` green: the active Codex profile can see login state.
- `omb exec ...` returns `OMB-EXEC-OK`: real execution, auth, provider routing, and current working-directory assumptions are working together.

## Green doctor, but `omx exec` fails with auth errors

Common failure strings include `401 Unauthorized`, `Missing bearer or basic authentication in header`, or `Incorrect API key provided`.

Check the active runtime profile, not only your normal login shell:

1. Print `HOME` and `CODEX_HOME` in the shell that launches OMX.
2. Confirm that the active `~/.codex` or `CODEX_HOME` contains the expected auth and `config.toml`.
3. Re-run `codex login status` from that same shell.

Custom HOME, container, profile, CI, and service-user environments often have a different `~/.codex` from the machine's main user. A working Codex setup in one home does not automatically make another home ready.

## Local proxy or `openai_base_url` mismatch

If your setup depends on an OpenAI-compatible local proxy or gateway, verify that the active runtime config contains the matching base URL:

```toml
openai_base_url = "http://localhost:8317/v1"
```

Use your actual proxy URL. If the profile-local `~/.codex/config.toml` is missing `openai_base_url`, Codex may send the proxy-issued key to the default endpoint. That can make setup and doctor look fine while real execution fails with 401-style auth errors.

## Stale `doctor --team` or dead tmux session state

`omb doctor --team`, `omb team resume`, or startup diagnostics can fail when a previous team state references a tmux session that no longer exists. The state may mention `resume_blocker`, or the dead session may be recorded under `.omb/state/team/<team-name>/config.json` or `manifest.v2.json` (legacy `.omx/state/...` copies may also exist).

If the team is intentionally abandoned and no live tmux session remains, clean it up with:

```bash
omb team shutdown <team-name> --force --confirm-issues
omb cancel
omb doctor --team
```

Do not force-shutdown a team that may still have useful live panes or worker state. Prefer `omb team status <team-name>` and `tmux ls` first when unsure.

## Shift+Enter submits instead of inserting a newline in tmux-backed OMB sessions

This is usually **not** a net-new OMB feature gap.

OMB already carries the tmux-side preservation work from issue `#1271` / PR `#1273` (`4405f582`, “Preserve Shift+Enter inside tmux-backed OMB launches”), and current `dev` still enables tmux `extended-keys=always` around OMB-owned Codex launch paths:

- in-tmux launches wrap Codex with `withTmuxExtendedKeys(...)` in `src/cli/runtime/launch-pipeline.ts`
- detached tmux launches acquire the same protection through the detached leader bootstrap/cleanup path in `src/cli/index.ts`
- regression tests still cover the enable/restore/lease behavior in `src/cli/__tests__/index.test.ts`

So if `Shift+Enter` still behaves like plain `Enter`, the narrowest likely causes are:

1. **tmux is not actually forwarding extended keys for the reporter's terminal path**
   - tmux only forwards the richer key event when the attached terminal is detected as supporting extended keys
   - `tmux show -gv extended-keys` can say `always`, but forwarding can still fail if the terminal capability is missing or not detected
2. **the reporter is not in the OMX-owned tmux launch path**
   - for example, reproducing in a different pane/session than the one OMX launched or after attaching through a different client path
3. **terminal-specific capability mismatch**
   - some terminals need an explicit tmux `terminal-features` hint for `extkeys`

### Operator checks

Run these from the same tmux client/session where the failure happens:

```bash
tmux show -gv extended-keys
tmux info | grep extkeys
tmux show -gv terminal-features
printf '%s\n' "$TERM" "$TERM_PROGRAM"
```

Expected first check: `always` while OMB is actively running Codex in that tmux-managed path.

If `extended-keys` is **not** `always` during the failing session, that points to an OMB launch-path bug/regression.

If `extended-keys` **is** `always`, but `Shift+Enter` still submits, the likely problem is terminal capability discovery or upstream Codex terminal-input interpretation rather than OMB submission logic.

### Typical environment fix

If your terminal supports extended keys but tmux does not detect it automatically, add an `extkeys` feature hint in `~/.tmux.conf` and restart tmux:

```tmux
set -as terminal-features ',xterm-256color:extkeys'
```

Adjust the terminal pattern if your client advertises a different terminfo name.

### Maintainer triage guidance

- **Open a code fix** only if you can show current `dev` fails to set `extended-keys=always` on the live OMB-owned tmux launch path.
- **Close as environment limitation** if current `dev` sets the tmux option correctly but the reporter's terminal path still does not forward the richer key event.
- **Prefer a docs follow-up** when the root problem is discoverability/operator guidance rather than a broken OMB codepath.
