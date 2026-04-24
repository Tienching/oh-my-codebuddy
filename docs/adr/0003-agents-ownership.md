# ADR 0003: AGENTS.md Ownership Model

## Status

Accepted

## Context

AGENTS.md is the primary instruction surface for CodeBuddy agents. Multiple modules need to compose content into AGENTS.md, but uncoordinated mutation leads to:

1. **Corrupted overlays** — When `agents-overlay.ts` and `worker-bootstrap.ts` both write to the same AGENTS.md file concurrently, marker-bounded sections can be interleaved or lost.
2. **Stale recovery state** — After a crash, there is no ledger recording what was modified, making it impossible to reliably restore the original file.
3. **Lock divergence** — Both modules implement their own file-locking mechanism with slightly different semantics (stale detection, timeout, owner metadata), leading to inconsistent behavior.

The current AGENTS.md surfaces are:

| Surface | Path | Writer | Markers |
|---------|------|--------|---------|
| User/Repo original | `{cwd}/AGENTS.md` | User | None |
| Session overlay | Written inline to `{cwd}/AGENTS.md` | `agents-overlay.ts` | `<!-- OMB:RUNTIME:START -->` / `<!-- OMB:RUNTIME:END -->` |
| Worker overlay | Written inline to `{cwd}/AGENTS.md` (worktree) | `worker-bootstrap.ts` | `<!-- OMB:TEAM:WORKER:START -->` / `<!-- OMB:TEAM:WORKER:END -->` |
| Worker root | `{worktree}/AGENTS.md` | `worker-bootstrap.ts` | Full file replacement |
| Session-scoped instructions | `.omb/state/{session}/AGENTS.md` | `agents-overlay.ts` | Composed (not in-place) |
| Team worker instructions | `.omb/state/team/{team}/worker-agents.md` | `worker-bootstrap.ts` | Composed (not in-place) |
| Per-worker role instructions | `.omb/state/team/{team}/workers/{worker}/AGENTS.md` | `worker-bootstrap.ts` | Composed (not in-place) |

## Decision

### 1. Three ownership categories with single owners

| Category | Description | Owner module | Mutation rule |
|----------|-------------|-------------|---------------|
| **Category 1: User/Repo original** | The user-authored `AGENTS.md` at the project root | User (never auto-modified in place) | OMB reads this but never writes to it directly. Session/worker overlays are appended via marker-bounded sections and stripped on cleanup. |
| **Category 2: Session overlay** | The `OMB:RUNTIME:START/END` marker-bounded section in the root AGENTS.md | `agents-overlay.ts` | Only `agents-overlay.ts` may apply or strip the runtime overlay. Worker code must not touch runtime markers. |
| **Category 3: Worker instructions** | The `OMB:TEAM:WORKER:START/END` marker-bounded section AND all worker-specific AGENTS files | `worker-bootstrap.ts` | Only `worker-bootstrap.ts` may apply or strip the worker overlay, write the worker root AGENTS.md, or manage the composed instruction files. |

### 2. No cross-category direct mutation

- `agents-overlay.ts` must not write to worker-owned surfaces (worker markers, worker root, team worker instructions).
- `worker-bootstrap.ts` must not write to session-owned surfaces (runtime markers, session-scoped instructions).
- Both modules may READ from Category 1 (user original) for composition.

### 3. Unified locking via shared module

Both modules currently implement file locking independently:
- `agents-overlay.ts`: Uses `mkdir`-based lock at `.omb/state/agents-md.lock`, with PID-based stale detection and 5s timeout.
- `worker-bootstrap.ts`: Uses `mkdir`-based lock at the same path (resolved via `lockPathFor()`), with PID + mtime-based stale detection, 5s timeout, and 30s stale threshold.

These are consolidated into `src/shared/locks/agents-lock.ts` with a single `withAgentsLock<T>()` function that both modules use.

### 4. Recovery ledger for crash safety

A recovery ledger (`src/team/agents-recovery.ts`) records every AGENTS.md mutation (path, original state, owner) before it happens. On startup or after a crash, the ledger can reconcile: if an owner process is dead and the file still has its overlay markers, the overlay is stripped and the original is restored.

## Consequences

### Positive

- **Clear ownership** — Each AGENTS.md surface has exactly one writer, eliminating concurrent mutation bugs.
- **Unified locking** — A single lock implementation ensures consistent stale detection and timeout behavior.
- **Crash recovery** — The recovery ledger makes it possible to clean up after crashes without manual intervention.
- **Testable** — Lock and recovery behavior can be tested independently of the overlay modules.

### Negative

- **Migration needed** — Both modules must be updated to use the shared lock and to respect category boundaries.
- **Slight indirection** — The shared lock adds one more import, but the complexity reduction is worth it.
- **Recovery ledger overhead** — Writing a ledger entry before each mutation adds I/O, but it is bounded (small JSON) and only occurs during overlay apply/strip operations.

## References

- `src/hooks/agents-overlay.ts` — Session overlay management, lock implementation (lines 51-119)
- `src/team/worker-bootstrap.ts` — Worker overlay management, lock implementation (lines 562-640)
- `src/shared/locks/agents-lock.ts` — Unified lock (new)
- `src/team/agents-recovery.ts` — Recovery ledger (new)
