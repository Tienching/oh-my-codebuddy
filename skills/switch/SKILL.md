---
name: switch
description: Prepare or launch a safe artifact-based OMB provider switch from the current interactive session to another provider.
---

<Purpose>
Use this skill only when the user explicitly asks for `$switch <provider>` inside an OMB session. It turns the current work into a provider-neutral handoff artifact, reviews it, and optionally launches a new target-provider session without pretending to hot-swap the current process.
</Purpose>

<Supported_Providers>
- Artifact/review targets: `codebuddy`, `codex`, `claude`, `gemini`.
- Interactive launch targets: `codebuddy`, `codex`, `claude`.
- `gemini` may be used for artifact/review workflows when supported by the handoff artifact layer, but do not launch it as a leader unless OMB leader support exists.
</Supported_Providers>

<Execution_Policy>
- Default final-output shape: quality-first and evidence-dense; use concise, evidence-dense progress and completion reporting with artifact paths, review verdict, launch/session details when present, and the explicit stop-editing statement.
- Treat newer user task updates as local overrides for the active workflow branch while preserving earlier non-conflicting constraints.
- If the user says `continue` after a prepared switch, continue only the safest missing switch step (usually review or launch), not unrelated implementation work.
- Do not edit feature code after a successful provider switch unless the user explicitly cancels or redirects the switch.
- Never claim the current process has switched providers. A switch launches or prepares a new session; it does not hot-swap the old one.
- Never kill the old session automatically. Keep the workflow safe and reversible.
</Execution_Policy>

<Argument_Parsing>
Parse the user prompt for:
- Target provider: first supported provider after `$switch`, `to`, or `provider`.
- `--task <text>`: current task summary for the target provider.
- `--launch`: create/review the artifact and start a new tmux-backed target-provider OMB session.

Infer when available:
- Current provider from `OMB_LEADER_CLI` or equivalent session context; otherwise use `unknown` or omit `--from` only if the CLI will infer it.
- Current mode from active OMB mode state; otherwise use `unknown`.
</Argument_Parsing>

<Workflow_No_Launch>
For `$switch <provider>` without `--launch`:
1. Run:
   `omb handoff --to <provider> --from <current-provider> --mode <current-mode> --task "<task>"`
   - Omit optional flags only when the value is not known.
2. Run:
   `omb review --handoff latest --with <provider>`
3. If the review rejects, report the required fixes and do not launch.
4. If the review approves, report:
   - `.omb/handoffs/latest.md`
   - the concrete handoff JSON/markdown path printed by the CLI
   - the review verdict
   - the exact launch command for the user if they want to continue later, usually `omb switch --to <provider> --handoff latest --launch` for leader providers.
5. End with: `I will stop editing in this session now.`
</Workflow_No_Launch>

<Workflow_With_Launch>
For `$switch <provider> --launch`:
1. Create the artifact with `omb handoff --to <provider> --from <current-provider> --mode <current-mode> --task ...`.
2. Review it with `omb review --handoff latest --with <provider>`.
3. If the review approves and `<provider>` is a leader provider, run:
   `omb switch --to <provider> --handoff latest --launch`
4. Confirm the new session is a NEW tmux-backed OMB session. Do not describe it as a hot-swap.
5. Ensure the new session receives, or the user is told how to inject, a takeover prompt containing `.omb/handoffs/latest.md`.
6. Print the launch helper's tmux message exactly when available, or use this shape:
   `New <provider> session is ready: <tmux-session-name>. Switch with: tmux switch-client -t <session> or attach with: tmux attach -t <session>. I will stop editing in this session now.`
</Workflow_With_Launch>

<State_Semantics>
- Prepared means artifact created and review-approved, but no new target session launched.
- Launched means the new tmux-backed target-provider session was started and recorded.
- Accepted means a target-provider session has taken over or the user explicitly marks the switch complete; do not infer acceptance merely from artifact creation.
- Record old session id and new session id where available via the switch/handoff CLI state.
</State_Semantics>

<Examples>
<Good>
User: `$switch claude --task "finish provider switch keyword support"`
Action: create and review handoff artifacts, report paths, then stop editing in the old session.
</Good>

<Good>
User: `$switch codex --launch --task "continue release verification"`
Action: create/review artifacts, launch a new Codex tmux-backed session, print the tmux switch/attach message, then stop editing in the old session.
</Good>

<Bad>
User: `switch provider to codex for review`
Why bad: implicit prose is no longer enough; require explicit `$switch` activation.
</Bad>
</Examples>
