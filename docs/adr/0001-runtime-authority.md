# ADR 0001: Rust/TypeScript Runtime Authority Model

## Status

Accepted

## Context

oh-my-codebuddy has both a Rust runtime (`omb-runtime`) and TypeScript orchestration code. Currently, the two layers have overlapping and sometimes conflicting ownership of state:

### Rust layer (omb-runtime)

The Rust binary owns authority/lease management, dispatch queue, mailbox records, backlog counters, and replay cursor. It exposes these through a command/event protocol via `execFileSync`:

- **RuntimeCommand variants**: `AcquireAuthority`, `RenewAuthority`, `QueueDispatch`, `MarkNotified`, `MarkDelivered`, `MarkFailed`, `RequestReplay`, `CaptureSnapshot`, `CreateMailboxMessage`, `MarkMailboxNotified`, `MarkMailboxDelivered`
- **RuntimeEvent variants**: Mirrors commands as events (e.g., `AuthorityAcquired`, `DispatchQueued`)
- **Compatibility JSON files**: `authority.json`, `readiness.json`, `backlog.json`, `dispatch.json`, `mailbox.json` — written by Rust, read by TS via `readCompatFile<T>()`

### TypeScript layer (omb)

TS directly writes state files for team state, session state, mode state, and AGENTS.md overlays. The `RuntimeBridge` class in `src/runtime/bridge.ts` is the TS interface to Rust:

- `execCommand()` sends a `RuntimeCommand` via `execFileSync` and returns a `RuntimeEvent`
- `readSnapshot()` reads the full `RuntimeSnapshot` from Rust
- `readCompatFile<T>()` reads Rust-authored compatibility JSON files
- Bridge is enabled by default (`OMB_RUNTIME_BRIDGE !== '0'`)
- Binary discovery: `OMB_RUNTIME_BINARY` / `OMB_RUNTIME_BINARY` env → workspace debug → workspace release → PATH fallback

### Current problems

1. **Dual-write risk**: TS can directly write files that Rust also manages (e.g., authority domain files), leading to race conditions and state corruption.
2. **Compatibility JSON is ad-hoc**: The compatibility files (`authority.json`, `readiness.json`, etc.) have no versioned schema, making evolution fragile.
3. **No clear boundary**: It is unclear which module owns which state domain, leading to subtle bugs when both layers try to manage the same resource.
4. **Fallback mode coexistence**: When bridge is disabled, TS-only code must still work, but the fallback paths sometimes write into Rust-owned state directories.

## Decision

### 1. Rust owns authority domain state

Rust is the single authority for:
- **Authority/lease management**: Acquiring, renewing, and checking authority leases (`AcquireAuthority`, `RenewAuthority`)
- **Dispatch queue**: Queueing, notifying, delivering, and failing dispatches (`QueueDispatch`, `MarkNotified`, `MarkDelivered`, `MarkFailed`)
- **Mailbox records**: Creating, notifying, and delivering mailbox messages (`CreateMailboxMessage`, `MarkMailboxNotified`, `MarkMailboxDelivered`)
- **Backlog counters**: Pending, notified, delivered, failed counts
- **Replay cursor**: Tracking event replay position and deferred notifications

### 2. TypeScript owns UX and orchestration

TS is the single authority for:
- **CLI UX**: All user-facing commands (`omb setup`, `omb doctor`, `omb explore`, etc.)
- **Setup/installation**: Skill installation, config generation, agent native config
- **Prompt generation**: AGENTS.md overlays, worker instructions, role prompts
- **AGENTS management**: Session overlay injection/stripping, worker overlay management
- **Display/formatting**: HUD status lines, tmux integration, notification routing
- **Team orchestration**: Worker lifecycle, task assignment, scaling, rebalancing

### 3. Compatibility JSON files are a temporary interface

The current compatibility JSON files (`authority.json`, `readiness.json`, `backlog.json`, `dispatch.json`, `mailbox.json`) are an interim mechanism for Rust-to-TS state communication. They:

- **Will be replaced** by a structured bridge API (potentially IPC or HTTP) in a future version
- **Must not be written by TS** when the bridge is enabled
- **Should have versioned schemas** if kept beyond the migration period

### 4. Bridge-enabled path enforces single authority

When `RuntimeBridge.isEnabled()` returns true:
- TS **MUST NOT** directly write files in the Rust authority domain
- All authority mutations go through `RuntimeBridge.execCommand()`
- All authority queries go through `RuntimeBridge.readCompatFile<T>()` or `readSnapshot()`
- The `readCompatFile<T>()` method is read-only by design; it never mutates

### 5. Fallback mode maintains minimum TS-only support

When the bridge is disabled (`OMB_RUNTIME_BRIDGE=0`):
- TS provides minimum-viable fallback for critical operations
- Fallback code paths are clearly separated from bridge-enabled paths
- Fallback mode does not write into Rust-owned state directories to avoid corruption on bridge re-enablement

## Consequences

### Positive

- **Single authority per domain** eliminates race conditions between Rust and TS
- **Clear module boundaries** make it easier to reason about state ownership and test each layer independently
- **Bridge API is the migration path** — as the compatibility JSON files are replaced, the `RuntimeBridge` interface remains stable
- **Fallback mode is explicit** rather than accidental

### Negative

- **Migration needed** for any current TS code that directly writes into Rust authority domain files
- **Compatibility files need versioned schemas** if they persist long-term (currently unversioned)
- **Bridge dependency** — when Rust binary is unavailable, some features degrade gracefully but cannot provide full authority management
- **Testing complexity** — two code paths (bridge-enabled, fallback) need test coverage

### Technical debt to track

1. Audit all TS code for direct writes to Rust authority domain files
2. Add schema versioning to compatibility JSON files
3. Design the replacement bridge API (IPC/HTTP) for the compatibility file mechanism
4. Add integration tests for the bridge-enabled/fallback boundary

## References

- `src/runtime/bridge.ts` — RuntimeBridge class, RuntimeCommand/Event types, compatibility file readers
- `src/team/state-root.ts` — State root resolution (bridge state dir)
- `src/hooks/agents-overlay.ts` — Session overlay management (TS-owned)
- `src/team/worker-bootstrap.ts` — Worker AGENTS management (TS-owned)
- `docs/contracts/runtime-command-event-snapshot-schema.md` — Command/event schema contract
- `docs/contracts/rust-runtime-thin-adapter-contract.md` — Thin adapter contract
