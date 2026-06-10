/**
 * Shared registry for Team API operation field schemas.
 *
 * This is the single source of truth for required/optional fields per operation.
 * CLI help generation, runtime validation, and future MCP schema generation
 * should all derive from this registry.
 *
 * @module api-operation-registry
 */

import type { TeamApiOperation } from './api-interop.js';

export interface TeamApiOperationSchema {
  /** Operation name */
  operation: TeamApiOperation;
  /** Fields that must be present for the operation to execute */
  required: readonly string[];
  /** Fields that are optional */
  optional: readonly string[];
  /** Human-readable notes about the operation */
  note?: string;
}

/**
 * Central registry of Team API operation field schemas.
 *
 * Each entry defines the required and optional input fields for a team API operation.
 * This replaces the previously duplicated TEAM_API_OPERATION_REQUIRED_FIELDS and
 * TEAM_API_OPERATION_OPTIONAL_FIELDS that lived only in cli/team.ts.
 */
export const TEAM_API_OPERATION_SCHEMAS: Readonly<Record<TeamApiOperation, TeamApiOperationSchema>> = {
  'send-message': {
    operation: 'send-message',
    required: ['team_name', 'from_worker', 'to_worker', 'body'],
    optional: [],
  },
  'broadcast': {
    operation: 'broadcast',
    required: ['team_name', 'from_worker', 'body'],
    optional: [],
  },
  'mailbox-list': {
    operation: 'mailbox-list',
    required: ['team_name', 'worker'],
    optional: [],
  },
  'mailbox-mark-delivered': {
    operation: 'mailbox-mark-delivered',
    required: ['team_name', 'worker', 'message_id'],
    optional: [],
  },
  'mailbox-mark-notified': {
    operation: 'mailbox-mark-notified',
    required: ['team_name', 'worker', 'message_id'],
    optional: [],
  },
  'create-task': {
    operation: 'create-task',
    required: ['team_name', 'subject', 'description'],
    optional: ['owner', 'blocked_by', 'requires_code_change'],
  },
  'read-task': {
    operation: 'read-task',
    required: ['team_name', 'task_id'],
    optional: [],
  },
  'list-tasks': {
    operation: 'list-tasks',
    required: ['team_name'],
    optional: [],
  },
  'update-task': {
    operation: 'update-task',
    required: ['team_name', 'task_id'],
    optional: ['subject', 'description', 'blocked_by', 'requires_code_change'],
    note: 'Only non-lifecycle task metadata can be updated.',
  },
  'claim-task': {
    operation: 'claim-task',
    required: ['team_name', 'task_id', 'worker'],
    optional: ['expected_version'],
  },
  'transition-task-status': {
    operation: 'transition-task-status',
    required: ['team_name', 'task_id', 'from', 'to', 'claim_token'],
    optional: ['result', 'error'],
    note: 'Lifecycle flow is claim-safe and typically transitions in_progress -> completed|failed.',
  },
  'release-task-claim': {
    operation: 'release-task-claim',
    required: ['team_name', 'task_id', 'claim_token', 'worker'],
    optional: [],
    note: 'Use this only for rollback/requeue to pending (not for completion).',
  },
  'read-config': {
    operation: 'read-config',
    required: ['team_name'],
    optional: [],
  },
  'read-manifest': {
    operation: 'read-manifest',
    required: ['team_name'],
    optional: [],
  },
  'read-worker-status': {
    operation: 'read-worker-status',
    required: ['team_name', 'worker'],
    optional: [],
  },
  'read-worker-heartbeat': {
    operation: 'read-worker-heartbeat',
    required: ['team_name', 'worker'],
    optional: [],
  },
  'update-worker-heartbeat': {
    operation: 'update-worker-heartbeat',
    required: ['team_name', 'worker', 'pid', 'turn_count', 'alive'],
    optional: [],
  },
  'write-worker-inbox': {
    operation: 'write-worker-inbox',
    required: ['team_name', 'worker', 'content'],
    optional: [],
  },
  'write-worker-identity': {
    operation: 'write-worker-identity',
    required: ['team_name', 'worker', 'index', 'role'],
    optional: [
      'assigned_tasks', 'pid', 'pane_id', 'working_dir',
      'worktree_path', 'worktree_branch', 'worktree_detached', 'team_state_root',
    ],
  },
  'append-event': {
    operation: 'append-event',
    required: ['team_name', 'type', 'worker'],
    optional: ['task_id', 'message_id', 'reason', 'state', 'prev_state', 'to_worker', 'worker_count', 'source_type', 'metadata'],
  },
  'read-events': {
    operation: 'read-events',
    required: ['team_name'],
    optional: ['after_event_id', 'wakeable_only', 'type', 'worker', 'task_id'],
  },
  'await-event': {
    operation: 'await-event',
    required: ['team_name'],
    optional: ['after_event_id', 'timeout_ms', 'poll_ms', 'wakeable_only', 'type', 'worker', 'task_id'],
  },
  'read-idle-state': {
    operation: 'read-idle-state',
    required: ['team_name'],
    optional: [],
  },
  'read-stall-state': {
    operation: 'read-stall-state',
    required: ['team_name'],
    optional: [],
  },
  'get-summary': {
    operation: 'get-summary',
    required: ['team_name'],
    optional: [],
  },
  'cleanup': {
    operation: 'cleanup',
    required: ['team_name'],
    optional: ['force', 'confirm_issues'],
  },
  'orphan-cleanup': {
    operation: 'orphan-cleanup',
    required: ['team_name'],
    optional: [],
  },
  'write-shutdown-request': {
    operation: 'write-shutdown-request',
    required: ['team_name', 'worker', 'requested_by'],
    optional: [],
  },
  'read-shutdown-ack': {
    operation: 'read-shutdown-ack',
    required: ['team_name', 'worker'],
    optional: ['min_updated_at'],
  },
  'read-monitor-snapshot': {
    operation: 'read-monitor-snapshot',
    required: ['team_name'],
    optional: [],
  },
  'write-monitor-snapshot': {
    operation: 'write-monitor-snapshot',
    required: ['team_name', 'snapshot'],
    optional: [],
  },
  'read-task-approval': {
    operation: 'read-task-approval',
    required: ['team_name', 'task_id'],
    optional: [],
  },
  'write-task-approval': {
    operation: 'write-task-approval',
    required: ['team_name', 'task_id', 'status', 'reviewer', 'decision_reason'],
    optional: ['required'],
  },
} as const;

/**
 * Get required fields for an operation.
 */
export function getRequiredFields(operation: TeamApiOperation): readonly string[] {
  return TEAM_API_OPERATION_SCHEMAS[operation]?.required ?? [];
}

/**
 * Get optional fields for an operation.
 */
export function getOptionalFields(operation: TeamApiOperation): readonly string[] {
  return TEAM_API_OPERATION_SCHEMAS[operation]?.optional ?? [];
}

/**
 * Get the note for an operation, if any.
 */
export function getOperationNote(operation: TeamApiOperation): string | undefined {
  return TEAM_API_OPERATION_SCHEMAS[operation]?.note;
}

/**
 * Validate that all required fields are present in the input args.
 * Returns an array of missing field names (empty if all present).
 */
export function validateRequiredFields(
  operation: TeamApiOperation,
  args: Record<string, unknown>,
): string[] {
  const required = getRequiredFields(operation);
  const missing: string[] = [];
  for (const field of required) {
    if (args[field] === undefined || args[field] === null || args[field] === '') {
      missing.push(field);
    }
  }
  return missing;
}
