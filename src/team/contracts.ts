export const TEAM_NAME_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]{0,29}$/;
export const WORKER_NAME_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TASK_ID_SAFE_PATTERN = /^\d{1,20}$/;

export const TEAM_TASK_STATUSES = ['pending', 'blocked', 'in_progress', 'completed', 'failed'] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

export const TEAM_TERMINAL_TASK_STATUSES: ReadonlySet<TeamTaskStatus> = new Set(['completed', 'failed']);
export const TEAM_TASK_STATUS_TRANSITIONS: Readonly<Record<TeamTaskStatus, readonly TeamTaskStatus[]>> = {
  pending: [],
  blocked: [],
  in_progress: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export function isTerminalTeamTaskStatus(status: TeamTaskStatus): boolean {
  return TEAM_TERMINAL_TASK_STATUSES.has(status);
}

export function canTransitionTeamTaskStatus(from: TeamTaskStatus, to: TeamTaskStatus): boolean {
  return TEAM_TASK_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export const TEAM_DISPATCH_REQUEST_STATUSES = ['pending', 'notified', 'delivered', 'failed'] as const;
export type TeamDispatchRequestStatus = (typeof TEAM_DISPATCH_REQUEST_STATUSES)[number];

export const TEAM_TERMINAL_DISPATCH_REQUEST_STATUSES: ReadonlySet<TeamDispatchRequestStatus> = new Set(['delivered', 'failed']);
export const TEAM_DISPATCH_REQUEST_STATUS_TRANSITIONS: Readonly<Record<TeamDispatchRequestStatus, readonly TeamDispatchRequestStatus[]>> = {
  pending: ['notified', 'failed'],
  notified: ['delivered', 'failed'],
  delivered: [],
  failed: [],
};

export function isTeamDispatchRequestStatus(status: unknown): status is TeamDispatchRequestStatus {
  return TEAM_DISPATCH_REQUEST_STATUSES.includes(status as TeamDispatchRequestStatus);
}

export function isTerminalTeamDispatchRequestStatus(status: TeamDispatchRequestStatus): boolean {
  return TEAM_TERMINAL_DISPATCH_REQUEST_STATUSES.has(status);
}

export function canTransitionTeamDispatchRequestStatus(from: TeamDispatchRequestStatus, to: TeamDispatchRequestStatus): boolean {
  return TEAM_DISPATCH_REQUEST_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export const TEAM_WORKER_INTEGRATION_STATUSES = [
  'idle',
  'integrated',
  'integration_failed',
  'cherry_pick_conflict',
  'rebase_conflict',
] as const;
export type TeamWorkerIntegrationStatus = (typeof TEAM_WORKER_INTEGRATION_STATUSES)[number];

export function isTeamWorkerIntegrationStatus(status: unknown): status is TeamWorkerIntegrationStatus {
  return TEAM_WORKER_INTEGRATION_STATUSES.includes(status as TeamWorkerIntegrationStatus);
}

export const TEAM_EVENT_TYPES = [
  'task_completed',
  'task_failed',
  'worker_state_changed',
  'worker_idle',
  'worker_stopped',
  'message_received',
  'leader_notification_deferred',
  'all_workers_idle',
  'shutdown_ack',
  'shutdown_gate',
  'shutdown_gate_forced',
  'ralph_cleanup_policy',
  'ralph_cleanup_summary',
  'approval_decision',
  'team_leader_nudge',
  'worker_diff_activity',
  'worker_diff_report',
  'worker_merge_report',
  'worker_merge_conflict',
  'worker_integration_failed',
  'worker_cherry_pick_detected',
  'worker_cherry_pick_applied',
  'worker_cherry_pick_conflict',
  'worker_rebase_applied',
  'worker_rebase_conflict',
  'worker_cross_rebase_applied',
  'worker_cross_rebase_conflict',
  'worker_cross_rebase_skipped',
  'worker_stale_diff',
  'worker_stale_heartbeat',
  'worker_stale_stdout',
  'merge_session_started',
  'merge_session_progress',
  'merge_session_completed',
  'merge_conflict_detected',
  'merge_conflict_dispatched',
  'merge_conflict_resolved',
] as const;
export type TeamEventType = (typeof TEAM_EVENT_TYPES)[number];

export const TEAM_WAKEABLE_EVENT_TYPES: ReadonlySet<TeamEventType> = new Set([
  'worker_state_changed',
  'task_completed',
  'task_failed',
  'worker_stopped',
  'message_received',
  'leader_notification_deferred',
  'all_workers_idle',
  'team_leader_nudge',
  'worker_integration_failed',
  'worker_merge_conflict',
  'worker_cherry_pick_conflict',
  'worker_rebase_conflict',
  'worker_cross_rebase_conflict',
  'worker_stale_diff',
  'worker_stale_heartbeat',
  'worker_stale_stdout',
  'merge_session_started',
  'merge_session_progress',
  'merge_session_completed',
  'merge_conflict_detected',
  'merge_conflict_dispatched',
  'merge_conflict_resolved',
]);

export function isWakeableTeamEventType(type: TeamEventType): boolean {
  return TEAM_WAKEABLE_EVENT_TYPES.has(type);
}

export const TEAM_TASK_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type TeamTaskApprovalStatus = (typeof TEAM_TASK_APPROVAL_STATUSES)[number];

export const TEAM_INTEROP_CONTRACT_NAME = 'team-api-interop' as const;
export const TEAM_INTEROP_PAYLOAD_VERSION = 2 as const;
export const TEAM_INTEROP_COMPATIBILITY_FALLBACK = 'legacy-envelope' as const;
export const TEAM_INTEROP_COMPATIBILITY_FIELDS = ['ok', 'operation', 'data', 'error'] as const;

export const TEAM_INTEROP_ERROR_CODES = [
  'invalid_input',
  'manifest_not_found',
  'operation_failed',
  'task_not_found',
  'team_not_found',
  'worker_not_found',
] as const;
export type TeamInteropErrorCode = (typeof TEAM_INTEROP_ERROR_CODES)[number];

export const TEAM_INTEROP_ERROR_CODE_ALIASES: Readonly<Record<string, TeamInteropErrorCode>> = {
  bad_request: 'invalid_input',
  invalid_arguments: 'invalid_input',
  invalid_request: 'invalid_input',
  manifest_missing: 'manifest_not_found',
  task_missing: 'task_not_found',
  team_missing: 'team_not_found',
  transport_failed: 'operation_failed',
  runtime_bridge_failed: 'operation_failed',
  worker_missing: 'worker_not_found',
};

export interface TeamInteropErrorDetail {
  code: TeamInteropErrorCode;
  message: string;
  legacy_code?: string;
}

export interface TeamLegacyApiSuccessEnvelope<TOperation extends string = string, TData extends Record<string, unknown> = Record<string, unknown>> {
  ok: true;
  operation: TOperation;
  data: TData;
}

export interface TeamLegacyApiErrorEnvelope<TOperation extends string = string> {
  ok: false;
  operation: TOperation | 'unknown';
  error: TeamInteropErrorDetail | { code: string; message: string };
}

export type TeamLegacyApiEnvelope<TOperation extends string = string, TData extends Record<string, unknown> = Record<string, unknown>> =
  | TeamLegacyApiSuccessEnvelope<TOperation, TData>
  | TeamLegacyApiErrorEnvelope<TOperation>;

export interface TeamVersionedApiSuccessEnvelope<TOperation extends string = string, TData extends Record<string, unknown> = Record<string, unknown>>
  extends TeamLegacyApiSuccessEnvelope<TOperation, TData> {
  contract: typeof TEAM_INTEROP_CONTRACT_NAME;
  version: typeof TEAM_INTEROP_PAYLOAD_VERSION;
  compatibility_fallback: typeof TEAM_INTEROP_COMPATIBILITY_FALLBACK;
  compatibility_fields: typeof TEAM_INTEROP_COMPATIBILITY_FIELDS;
  status: 'ok';
  result: TData;
}

export interface TeamVersionedApiErrorEnvelope<TOperation extends string = string> extends TeamLegacyApiErrorEnvelope<TOperation> {
  contract: typeof TEAM_INTEROP_CONTRACT_NAME;
  version: typeof TEAM_INTEROP_PAYLOAD_VERSION;
  compatibility_fallback: typeof TEAM_INTEROP_COMPATIBILITY_FALLBACK;
  compatibility_fields: typeof TEAM_INTEROP_COMPATIBILITY_FIELDS;
  status: 'error';
  errors: readonly [TeamInteropErrorDetail];
}

export type TeamVersionedApiEnvelope<TOperation extends string = string, TData extends Record<string, unknown> = Record<string, unknown>> =
  | TeamVersionedApiSuccessEnvelope<TOperation, TData>
  | TeamVersionedApiErrorEnvelope<TOperation>;

export type TeamApiEnvelopeContract<TOperation extends string = string, TData extends Record<string, unknown> = Record<string, unknown>> =
  | TeamLegacyApiEnvelope<TOperation, TData>
  | TeamVersionedApiEnvelope<TOperation, TData>;

export function isTeamInteropErrorCode(code: unknown): code is TeamInteropErrorCode {
  return TEAM_INTEROP_ERROR_CODES.includes(code as TeamInteropErrorCode);
}

export function normalizeTeamInteropErrorCode(code: unknown): TeamInteropErrorCode {
  if (isTeamInteropErrorCode(code)) return code;
  if (typeof code === 'string') {
    const normalized = code.trim().toLowerCase();
    if (isTeamInteropErrorCode(normalized)) return normalized;
    if (normalized in TEAM_INTEROP_ERROR_CODE_ALIASES) {
      return TEAM_INTEROP_ERROR_CODE_ALIASES[normalized];
    }
  }
  return 'operation_failed';
}
