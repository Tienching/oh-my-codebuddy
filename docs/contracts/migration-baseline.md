# Migration Baseline Contract

This contract freezes the T01 / T01A planning baseline before any high-risk port
adds a new write path. Until the shadow gates in
`docs/qa/migration-shadow-gates.md` are green, all migration work remains
**pass-by-default**:

- feature flags stay `false` by default,
- legacy CLI/runtime/state writers stay authoritative,
- new contracts are additive and reversible.

## Migration categories

| Class | Use when | Scheduling rule | Default rollback |
|---|---|---|---|
| `direct-port` | Read-only or leaf behavior can be copied without changing authoritative state writers | Allowed only after task-level tests prove no CLI/runtime drift | Remove the copied surface and keep the existing entrypoint authoritative |
| `adapter-first` | CLI, state, hooks, tmux, MCP, or persistence behavior may drift from current semantics | Must ship behind a named feature flag with legacy path preserved | Turn the flag off and route all writes back to the current implementation |
| `reference-only` | Upstream behavior is informative but should not become a shipped runtime surface yet | Keep as docs/reference input only; no runtime cutover | Drop the reference work without affecting shipped paths |

## Module migration matrix

Coverage summary:

- `analysis_snapshot.shared_top_dirs`: **14 / 14 mapped**
- `analysis_snapshot.high_value_candidates_in_oh_my_claudecode`: **8 / 8 assigned**

| Source module | Target surface in this repo | Class | Planned tasks | Default guardrail |
|---|---|---|---|---|
| `agents` | `src/agents`, prompt overlays | `reference-only` | T05, T07 | Keep current agent catalog authoritative |
| `autoresearch` | `src/autoresearch` | `reference-only` | T12 | Treat upstream ideas as QA inputs only |
| `cli` | `src/cli`, `src/commands` | `adapter-first` | T02, T03, T13 | Preserve `omb` / `omx` behavior until adapter tests pass |
| `config` | `src/config`, `src/utils/paths.ts` | `adapter-first` | T02, T04, T07 | Keep existing config resolution authoritative |
| `features` | `src/features` | `adapter-first` | T04, T05 | Route new behavior through off-by-default flags |
| `hooks` | `src/hooks` | `adapter-first` | T05, T07, T13 | Fail-open and isolate hook faults from the main path |
| `hud` | `src/hud` | `reference-only` | T12 | No HUD contract changes without separate validation |
| `index.ts` | `src/index.ts` | `reference-only` | T12 | Avoid entrypoint churn during migration |
| `mcp` | `src/mcp`, `src/team/mcp-comm.ts` | `adapter-first` | T08, T14 | Preserve current MCP server wiring as the default |
| `notifications` | `src/notifications` | `reference-only` | T12 | Keep current notify flow unless a release gate says otherwise |
| `openclaw` | `src/openclaw` | `reference-only` | T12 | Track only as an observability reference |
| `planning` | `src/planning`, `.omx/plans` | `reference-only` | T01, T12 | Planning artifacts stay additive |
| `team` | `src/team` | `adapter-first` | T06, T14 | Legacy runtime remains the only write path until shadow parity is green |
| `tools` | `src/tools`, `src/shared-memory` | `adapter-first` | T08, T13 | Keep the existing tool registry and memory paths authoritative |
| `providers` (upstream-only) | `src/providers`, `src/features/context-injector` | `adapter-first` | T04 | Do not alter routing without provider fallback coverage |
| `platform` / `installer` (upstream-only) | `src/cli/setup.ts`, `src/cli/update.ts`, `src/installer` | `adapter-first` | T03, T15 | Installer facade remains opt-in until dry-run gates pass |
| `interop` (upstream-only) | `src/team/api-interop.ts`, `src/team/contracts.ts` | `adapter-first` | T14 | Keep legacy envelope aliases until golden fixtures stay green |
| `verification` (upstream-only) | `src/verification`, `.github/workflows` | `direct-port` | T12 | Verification may tighten gates, but must not change runtime semantics |

## Conflict matrix

| Surface | Current conflict to preserve | Owning tasks | Guardrail | Regression evidence |
|---|---|---|---|---|
| CLI | `omb` / `omx` command names and argument forwarding must remain stable while adapters are introduced | T02, T03, T13 | Wrap new command loaders behind feature flags and keep existing dispatch as fallback | CLI tests + `migration-baseline-gate` |
| Paths | `.omb` / `.omx` are canonical; `.codex` / legacy paths are compatibility-only | T02, T03, T15 | Never change canonical path ownership in the first port step | setup/update tests + release gates |
| Hooks | Hook extensions may fail, but must not block the main workflow | T05, T07, T13 | Preserve fail-open isolation and keep old load order as default | hooks tests + QA gate checklist |
| State | Team, Ralph, and interop payloads must freeze schema before any v2 writer lands | T01A, T06, T08, T14 | Freeze fixtures first, then allow only shadow diffs behind flags | `src/ralph/__tests__/persistence.test.ts`, `src/team/__tests__/state.test.ts`, `src/team/__tests__/api-interop.test.ts` |

## Milestones

| Milestone | Included tasks | Acceptance |
|---|---|---|
| `M0-contract-freeze` | T01, T01A | Decision matrix, dependency topology, migration fixtures, feature-flag registry, and rollback owners are frozen and verified |
| `M1-passive-adapters` | T02, T03, T04, T05 | New adapters exist but stay off by default; legacy CLI/runtime paths remain authoritative |
| `M2-shadow-runtime` | T14, T06, T07, T08, T13 | Interop and team shadow diffs are observable, reversible, and backed by golden fixtures |
| `M3-release-gates` | T12, T15 | CI/release gates enforce migration evidence before any rollout expands |

## Dependency topology

Linear execution order for the current plan:

`T01 -> T01A -> T03 -> T02 -> T14 -> T04 -> T05 -> T06 -> T07 -> T13 -> T08 -> T12 -> T15`

Rules:

1. `T01A` depends on `T01`.
2. No task may appear before any dependency listed in `task.json`.
3. Any new P0/P1 task must declare a feature flag and rollback owner before it is inserted into this order.

## Migration fixture inventory

### Ralph fixtures

| Fixture | Purpose | Evidence |
|---|---|---|
| Legacy PRD one-way import (`.omb/prd.json` -> `.omb/plans/prd-*.md`) | Freeze one-way migration from JSON to canonical markdown | `src/ralph/__tests__/persistence.test.ts` |
| Legacy progress one-way import (`.omb/progress.txt` -> `.omb/state/{scope}/ralph-progress.json`) | Freeze one-way import to the canonical progress ledger | `src/ralph/__tests__/persistence.test.ts` |
| Canonical artifact precedence | Keep canonical PRD/progress authoritative when both legacy and canonical artifacts exist | `src/ralph/__tests__/persistence.test.ts` |

### Team fixtures

| Fixture | Purpose | Evidence |
|---|---|---|
| Manifest / worker / dispatch round-trips | Freeze current team state read/write semantics before shadow routing | `src/team/__tests__/state.test.ts` (`migrateV1ToV2 writes manifest.v2.json idempotently from legacy config.json`) |
| Team ops contract coverage | Freeze API-level reads/writes used by the team interop surface | `src/team/__tests__/state.test.ts` (`dispatch request store enqueues, dedupes, and transitions idempotently`) |
| State root precedence | Keep canonical team state root resolution stable during migration | `src/team/__tests__/state.test.ts` (`dispatch bridge queue uses the same request id as the TS store`) |

### Interop golden payload baseline

Current baseline: **`legacy-v0`**. The shipped envelope is the existing
`TeamApiEnvelope` shape in `src/team/api-interop.ts`; it does **not** require an
explicit `schema_version` field yet. Future `v1` envelopes remain gated behind
`OMB_INTEROP_VERSIONED_PAYLOAD`.

Success golden payload (`legacy-v0`):

```json
{
  "ok": true,
  "operation": "send-message",
  "data": {
    "message": {
      "message_id": "msg-123",
      "from_worker": "worker-1",
      "to_worker": "worker-2",
      "body": "hello"
    },
    "dispatch": {
      "message_id": "msg-123",
      "transport": "hook_preferred_with_fallback"
    }
  }
}
```

Failure golden payload (`legacy-v0`):

```json
{
  "ok": false,
  "operation": "send-message",
  "error": {
    "code": "invalid_input",
    "message": "team_name, from_worker, to_worker, body are required"
  }
}
```

Regression evidence: `src/team/__tests__/api-interop.test.ts` (`executeTeamApiOperation: versioned interop payloads`).

## Feature-flag registry baseline

The authoritative registry lives in `task.json`. Every P0/P1 task now declares
at least one flag with a default value and owner, plus a rollback owner + steps.
The QA gate treats missing metadata as a release blocker.
