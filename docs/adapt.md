# `omb adapt`

`omb adapt <target>` is the OMB-owned surface for persistent external-agent adaptation.

Shared foundation behavior:

- CLI scaffold for `probe`, `status`, `init`, `envelope`, and `doctor`
- shared capability reporting with explicit ownership (`omb-owned`, `shared-contract`, `target-observed`)
- adapter-owned paths under `.omb/adapters/<target>/...`
- shared envelope/status/doctor/init behavior that does not touch `.omb/state/...`

OpenClaw follow-on behavior:

- `omb adapt openclaw probe` observes existing local OpenClaw config/env/gateway evidence
- `omb adapt openclaw status` synthesizes local adapter status from env gates, config source, hook mappings, and command-gateway opt-in
- `omb adapt openclaw envelope` includes lifecycle bridge metadata for the existing OMB to OpenClaw event mapping
- `omb adapt openclaw init --write` still writes only under `.omb/adapters/openclaw/...`

Current targets:

- `openclaw`
- `hermes`

Hermes follow-on behavior in this worktree:

- `probe` inspects external Hermes ACP, gateway, and session-store evidence
- `status` synthesizes `unavailable` / `installed` / `degraded` / `running` from observable Hermes files only
- `envelope` includes Hermes bootstrap metadata for ACP commands, lifecycle bridge guidance, and status commands
- `init --write` still writes only under `.omb/adapters/hermes/...`; Hermes runtime files remain read-only inputs

Examples:

```bash
omb adapt openclaw probe
omb adapt hermes status --json
omb adapt openclaw init --write
omb adapt hermes envelope --json
```

Foundation constraints:

- thin adapter surface only, not a bidirectional control plane
- no direct writes to `.omb/state/...`
- no direct writes to external runtime internals
- target capability reporting stays asymmetric; OMB reports what it owns, what is shared, and what is only target-observed
- OpenClaw status is local evidence only; it does not claim downstream runtime acknowledgement or execution
- command-gateway readiness still requires `OMB_OPENCLAW_COMMAND=1`

Hermes-specific evidence discovery uses `HERMES_HOME` plus an overrideable Hermes source root (`OMB_ADAPT_HERMES_ROOT`) so OMB can inspect an external runtime without vendoring or mutating it.
