/**
 * Team Governance - Normalization and defaults for team governance/policy
 *
 * Provides normalization functions that merge partial governance and
 * transport policy configs with defaults, ensuring all required fields
 * exist. Supports backward compatibility with legacy policy shapes.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type LifecycleProfile = "default" | "linked_ralph";

export interface TeamTransportPolicy {
  display_mode: "split_pane" | "separate_windows";
  worker_launch_mode: "interactive" | "detached";
  dispatch_mode:
    | "hook_preferred_with_fallback"
    | "transport_direct"
    | "prompt_stdin";
  dispatch_ack_timeout_ms: number;
}

export interface TeamGovernance {
  delegation_only: boolean;
  plan_approval_required: boolean;
  nested_teams_allowed: boolean;
  one_team_per_leader_session: boolean;
  cleanup_requires_all_workers_inactive: boolean;
}

export const DEFAULT_TEAM_TRANSPORT_POLICY: TeamTransportPolicy = {
  display_mode: "split_pane",
  worker_launch_mode: "interactive",
  dispatch_mode: "hook_preferred_with_fallback",
  dispatch_ack_timeout_ms: 15000,
};

export const DEFAULT_TEAM_GOVERNANCE: TeamGovernance = {
  delegation_only: false,
  plan_approval_required: false,
  nested_teams_allowed: false,
  one_team_per_leader_session: true,
  cleanup_requires_all_workers_inactive: true,
};

// ── Normalization ──────────────────────────────────────────────────────

/**
 * Normalize a partial transport policy by merging with defaults.
 * Handles legacy policy shapes where fields may be at the top level.
 */
export function normalizeTeamTransportPolicy(
  policy?: Partial<TeamTransportPolicy> & Record<string, unknown>,
): TeamTransportPolicy {
  if (!policy) return { ...DEFAULT_TEAM_TRANSPORT_POLICY };

  return {
    display_mode:
      (policy.display_mode as TeamTransportPolicy["display_mode"]) ??
      DEFAULT_TEAM_TRANSPORT_POLICY.display_mode,
    worker_launch_mode:
      (policy.worker_launch_mode as TeamTransportPolicy["worker_launch_mode"]) ??
      DEFAULT_TEAM_TRANSPORT_POLICY.worker_launch_mode,
    dispatch_mode:
      (policy.dispatch_mode as TeamTransportPolicy["dispatch_mode"]) ??
      DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_mode,
    dispatch_ack_timeout_ms:
      typeof policy.dispatch_ack_timeout_ms === "number"
        ? policy.dispatch_ack_timeout_ms
        : DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_ack_timeout_ms,
  };
}

/**
 * Normalize a partial governance config by merging with defaults.
 * Supports fallback to legacy policy fields for backward compatibility.
 */
export function normalizeTeamGovernance(
  governance?: Partial<TeamGovernance> & Record<string, unknown>,
  legacyPolicy?: Record<string, unknown>,
): TeamGovernance {
  const source = governance ?? legacyPolicy ?? {};

  return {
    delegation_only:
      typeof source.delegation_only === "boolean"
        ? source.delegation_only
        : DEFAULT_TEAM_GOVERNANCE.delegation_only,
    plan_approval_required:
      typeof source.plan_approval_required === "boolean"
        ? source.plan_approval_required
        : DEFAULT_TEAM_GOVERNANCE.plan_approval_required,
    nested_teams_allowed:
      typeof source.nested_teams_allowed === "boolean"
        ? source.nested_teams_allowed
        : DEFAULT_TEAM_GOVERNANCE.nested_teams_allowed,
    one_team_per_leader_session:
      typeof source.one_team_per_leader_session === "boolean"
        ? source.one_team_per_leader_session
        : DEFAULT_TEAM_GOVERNANCE.one_team_per_leader_session,
    cleanup_requires_all_workers_inactive:
      typeof source.cleanup_requires_all_workers_inactive === "boolean"
        ? source.cleanup_requires_all_workers_inactive
        : DEFAULT_TEAM_GOVERNANCE.cleanup_requires_all_workers_inactive,
  };
}

/**
 * Normalize both policy and governance on a manifest object.
 * Mutates the manifest in place and returns it.
 */
export function normalizeTeamManifest(manifest: {
  policy?: Partial<TeamTransportPolicy> & Record<string, unknown>;
  governance?: Partial<TeamGovernance> & Record<string, unknown>;
  transport_policy?: Partial<TeamTransportPolicy> & Record<string, unknown>;
  lifecycle_profile?: LifecycleProfile;
}): {
  policy: TeamTransportPolicy;
  governance: TeamGovernance;
  lifecycle_profile: LifecycleProfile;
} {
  return {
    policy: normalizeTeamTransportPolicy(
      manifest.policy ?? manifest.transport_policy,
    ),
    governance: normalizeTeamGovernance(manifest.governance, manifest.policy),
    lifecycle_profile: manifest.lifecycle_profile ?? "default",
  };
}

/**
 * Resolve the lifecycle profile from config and/or manifest.
 * Manifest takes precedence over config. Defaults to 'default'.
 */
export function resolveLifecycleProfile(
  config?: { lifecycle_profile?: LifecycleProfile },
  manifest?: { lifecycle_profile?: LifecycleProfile },
): LifecycleProfile {
  return manifest?.lifecycle_profile ?? config?.lifecycle_profile ?? "default";
}

/** Check if the profile is 'linked_ralph'. */
export function isLinkedRalphProfile(
  config?: { lifecycle_profile?: LifecycleProfile },
  manifest?: { lifecycle_profile?: LifecycleProfile },
): boolean {
  return resolveLifecycleProfile(config, manifest) === "linked_ralph";
}
