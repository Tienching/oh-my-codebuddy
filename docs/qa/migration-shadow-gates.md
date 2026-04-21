# Migration Shadow Gates

<!-- markdownlint-disable MD013 -->

This QA plan is the release gate for the T01 / T01A migration baseline. It is a
**contract gate**, not a runtime cutover gate: it proves that the migration can
start safely without changing default behavior.

## Latest validation report

- `2026-04-20` — `docs/qa/migration-baseline-review-2026-04-20.md`
  (contract-freeze review with fresh build + gate evidence)

## Pass-by-default safeguards

1. Every new migration flag stays `false` by default.
2. Legacy CLI/runtime/state writers remain authoritative until the matching
   shadow gate is green.
3. `task.json` pass fields may flip to `true` only when the evidence listed in
   the gate matrix exists and the referenced tests/docs are green.
4. Any missing feature flag, rollback owner, or rollback steps blocks the task
   from entering implementation.

## Gate matrix

| ID | Gate | Required evidence | Failure action |
| --- | --- | --- | --- |
| G1 | Decision matrix + dependency topology are frozen | `docs/contracts/migration-baseline.md`, `src/verification/__tests__/migration-baseline-gate.test.ts` | Revert T01 pass flips and treat the plan as draft-only |
| G2 | Conflict matrix covers CLI / paths / hooks / state | `docs/contracts/migration-baseline.md`, `src/verification/__tests__/migration-baseline-gate.test.ts` | Do not land adapter code for the affected surface |
| G3 | Ralph one-way + idempotent migration fixtures stay green | `src/ralph/__tests__/persistence.test.ts` | Keep Ralph migration work docs-only |
| G4 | Team state fixtures stay frozen before shadow routing | `src/team/__tests__/state.test.ts` (`migrateV1ToV2...`, `dispatch request store enqueues...`, `dispatch bridge queue uses the same request id as the TS store`) | Keep legacy team state as the only runtime authority |
| G5 | Interop success + failure golden payloads stay green | `src/team/__tests__/api-interop.test.ts` (`executeTeamApiOperation: versioned interop payloads`) | Keep `OMB_INTEROP_VERSIONED_PAYLOAD=false` |
| G6 | P0/P1 feature-flag + rollback metadata stays complete | `task.json`, `src/verification/__tests__/migration-baseline-gate.test.ts` | Reject task pass changes and restore missing metadata |

## Subtask evidence map

| Task | Evidence required before `pass=true` |
| --- | --- |
| `T01.1` | Module matrix in `docs/contracts/migration-baseline.md` + `migration-baseline-gate` |
| `T01.2` | Conflict matrix in `docs/contracts/migration-baseline.md` + `migration-baseline-gate` |
| `T01.3` | Milestones + topology in `task.json` + `migration-baseline-gate` |
| `T01A.1` | Fixture inventory in `docs/contracts/migration-baseline.md` + Ralph/team fixture tests |
| `T01A.2` | Interop golden payload section in `docs/contracts/migration-baseline.md` + `api-interop.test.ts` |
| `T01A.3` | `task.json` feature flags / rollback owners + `migration-baseline-gate` |

## Shadow diff report template

Use this template before any adapter-first task enables a write path.

```md
### Shadow diff report
- Task:
- Flag:
- Baseline command / scenario:
- Candidate command / scenario:
- Expected invariant:
- Observed diff:
- Severity: none | low | medium | high
- Rollback trigger:
- Rollback owner:
- Follow-up gate:
```

## Rollback runbook template

```md
### Rollback runbook
- Trigger date:
- Task / flag:
- Owner:
- Detection signal:
- Immediate action: set flag back to `false`
- State cleanup steps:
- Artifact cleanup steps:
- Verification command(s):
- Exit criteria:
```

## Recommended validation command set

```bash
npm run build
node --test dist/verification/__tests__/migration-baseline-gate.test.js
node --test dist/ralph/__tests__/persistence.test.js
node --test --test-name-pattern 'migrateV1ToV2 writes manifest.v2.json idempotently|dispatch request store enqueues, dedupes, and transitions idempotently|dispatch bridge queue uses the same request id as the TS store' dist/team/__tests__/state.test.js
node --test dist/team/__tests__/team-ops-contract.test.js dist/team/__tests__/state-root.test.js
node --test --test-name-pattern 'executeTeamApiOperation: versioned interop payloads' dist/team/__tests__/api-interop.test.js
```
