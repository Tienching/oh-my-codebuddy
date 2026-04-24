# OMB Team Mutation Contract for Interop Brokers

This document defines the supported **mutation path** for external interoperability brokers.

## Rule of record

External systems must mutate team state through CLI interop:

```bash
omb team api <operation> --input '<json-object>' --json
```

Legacy `team_*` MCP APIs are hard-deprecated and return a deprecation error with a CLI hint.
Direct writes to `.omb/state/team/...` are unsupported and may violate runtime invariants.

## Required task mutation flow

1. Read current task:
   - `omb team api read-task --json`
2. Claim with optimistic version:
   - `omb team api claim-task --json`
3. Transition terminal state with claim token:
   - `omb team api transition-task-status --json` (`in_progress -> completed|failed`)
4. Use `omb team api release-task-claim --json` only for rollback/requeue-to-pending flows.

## Legacy MCP -> CLI migration table

| Legacy `team_*` tool | CLI operation |
|---|---|
| `team_send_message` | `omb team api send-message --json` |
| `team_broadcast` | `omb team api broadcast --json` |
| `team_mailbox_list` | `omb team api mailbox-list --json` |
| `team_mailbox_mark_notified` | `omb team api mailbox-mark-notified --json` |
| `team_mailbox_mark_delivered` | `omb team api mailbox-mark-delivered --json` |
| `team_create_task` | `omb team api create-task --json` |
| `team_read_task` | `omb team api read-task --json` |
| `team_list_tasks` | `omb team api list-tasks --json` |
| `team_update_task` | `omb team api update-task --json` |
| `team_claim_task` | `omb team api claim-task --json` |
| `team_transition_task_status` | `omb team api transition-task-status --json` |
| `team_release_task_claim` | `omb team api release-task-claim --json` |
| `team_read_config` | `omb team api read-config --json` |
| `team_read_manifest` | `omb team api read-manifest --json` |
| `team_read_worker_status` | `omb team api read-worker-status --json` |
| `team_read_worker_heartbeat` | `omb team api read-worker-heartbeat --json` |
| `team_update_worker_heartbeat` | `omb team api update-worker-heartbeat --json` |
| `team_write_worker_inbox` | `omb team api write-worker-inbox --json` |
| `team_write_worker_identity` | `omb team api write-worker-identity --json` |
| `team_append_event` | `omb team api append-event --json` |
| `team_get_summary` | `omb team api get-summary --json` |
| `team_cleanup` | `omb team api cleanup --json` |
| `team_write_shutdown_request` | `omb team api write-shutdown-request --json` |
| `team_read_shutdown_ack` | `omb team api read-shutdown-ack --json` |
| `team_read_monitor_snapshot` | `omb team api read-monitor-snapshot --json` |
| `team_write_monitor_snapshot` | `omb team api write-monitor-snapshot --json` |
| `team_read_task_approval` | `omb team api read-task-approval --json` |
| `team_write_task_approval` | `omb team api write-task-approval --json` |

## Message lifecycle operations

- send: `send-message`, `broadcast`
- inspect: `mailbox-list`
- delivery markers: `mailbox-mark-notified`, `mailbox-mark-delivered`

## Dispatch policy (authoritative path)

- Use `omb team api ... --json` + team state files as the authoritative delivery/control path.
- Direct tmux typing (`tmux send-keys`, repeated Enter injection) is operational fallback only, not a mutation contract.
- Interop brokers and worker automations should never assume tmux keystroke delivery implies successful mailbox/task mutation; always verify via JSON envelope + state reads.
- Rust-core + thin-adapter reader compatibility and release gating are documented in
  `docs/contracts/rust-runtime-thin-adapter-contract.md` and
  `docs/qa/rust-runtime-thin-adapter-gate.md`.

## Event read / wakeability contract

When brokers inspect team events via `read-events` / `await-event`:

- Events are returned in canonical form. Legacy `worker_idle` log entries normalize to `worker_state_changed` and keep `source_type: "worker_idle"`.
- `wakeable_only=true` mirrors `omb team await` semantics. Wakeable events include terminal task events, worker state changes, `leader_notification_deferred`, `all_workers_idle`, `team_leader_nudge`, `worker_merge_conflict`, and the per-signal stale alerts.
- Audit-only diff/report events such as `worker_diff_report` and `worker_merge_report` stay durable but non-wakeable.
- `worker_merge_conflict` remains the compatibility event for actionable integration conflicts; consumers should continue routing conflict handling on that event type while reading richer `metadata` when present.

## JSON envelope contract

`--json` output is machine-readable and stable:

- success:
  - `{"schema_version":"1.0","timestamp":"<ISO>","command":"omb team api <operation>","ok":true,"operation":"<operation>","data":{...}}`
- failure:
  - `{"schema_version":"1.0","timestamp":"<ISO>","command":"omb team api ...","ok":false,"operation":"<operation|unknown>","error":{"code":"<code>","message":"<message>"}}`

## Notes

- `transition-task-status` is the claim-safe terminal transition path.
  - Runtime enforces `in_progress -> completed|failed`; other transitions return `invalid_transition`.
- `release-task-claim` intentionally resets the task to `pending`; it is not a completion operation.
- `update-task` only accepts `subject`, `description`, `blocked_by`, and `requires_code_change` as mutable fields.
- `append-event.type` and `write-task-approval.status` enforce strict enum validation.
