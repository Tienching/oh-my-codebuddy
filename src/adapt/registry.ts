import {
  ADAPT_TARGETS,
  type AdaptCapabilityReport,
  type AdaptTarget,
  type AdaptTargetDescriptor,
} from "./contracts.js";

function capability(
	id: string,
	label: string,
	ownership: AdaptCapabilityReport["ownership"],
	status: AdaptCapabilityReport["status"],
	summary: string,
): AdaptCapabilityReport {
	return {
		id,
		label,
		ownership,
		status,
		summary,
	};
}

const FOUNDATION_CAPABILITIES: AdaptCapabilityReport[] = [
	capability(
		"omb-adapter-paths",
		"OMB-owned adapter paths",
		"omb-owned",
		"ready",
		"Adapter artifacts stay under .omb/adapters/<target>/... rather than .omb/state or target internals.",
	),
	capability(
		"planning-artifact-linkage",
		"Planning artifact linkage",
		"shared-contract",
		"ready",
		"Envelope output links canonical OMB PRD/test-spec artifacts when they exist.",
	),
	capability(
		"foundation-reporting",
		"Foundation reporting surface",
		"shared-contract",
		"ready",
		"Probe, status, envelope, init, and doctor share a target-agnostic output contract.",
	),
];

const TARGET_DESCRIPTORS: Record<AdaptTarget, AdaptTargetDescriptor> = {
	openclaw: {
		target: "openclaw",
		displayName: "OpenClaw",
		summary:
			"OMB-owned adapter around existing OpenClaw notification, gateway, and lifecycle observation surfaces.",
		followupHint:
			"Status reflects local OpenClaw config/env/gateway evidence only; remote acknowledgement remains out of scope.",
		capabilities: [
			...FOUNDATION_CAPABILITIES,
			capability(
				"gateway-observation",
				"Gateway observation",
				"target-observed",
				"ready",
				"Local OpenClaw config/env/gateway evidence is observed through existing config and gateway resolution seams.",
			),
			capability(
				"lifecycle-bridge",
				"Lifecycle bridge metadata",
				"shared-contract",
				"ready",
				"Probe, status, and envelope surface the existing OMB to OpenClaw lifecycle mapping without claiming remote execution health.",
			),
		],
	},
	hermes: {
		target: "hermes",
		displayName: "Hermes",
		summary:
			"Foundation seam for an OMB-owned adapter around Hermes ACP, gateway, and persistent-session surfaces.",
		followupHint:
			"Hermes adapter reads external ACP, gateway, and session-store evidence while keeping all writes under .omb/adapters/hermes/.",
		capabilities: [
			...FOUNDATION_CAPABILITIES,
			capability(
				"persistent-session-observation",
				"Persistent session observation",
				"target-observed",
				"stub",
				"Hermes session-store evidence is read from HERMES_HOME-scoped state.db when available.",
			),
			capability(
				"acp-envelope-bridge",
				"ACP envelope bridge",
				"shared-contract",
				"stub",
				"Hermes envelope/bootstrap metadata maps OMB lifecycle intent into ACP and gateway guidance without claiming deep control.",
			),
		],
	},
};

export function listAdaptTargets(): AdaptTargetDescriptor[] {
	return ADAPT_TARGETS.map((target) => TARGET_DESCRIPTORS[target]);
}

export function getAdaptTargetDescriptor(
	target: string,
): AdaptTargetDescriptor | null {
	return Object.hasOwn(TARGET_DESCRIPTORS, target)
		? TARGET_DESCRIPTORS[target as AdaptTarget]
		: null;
}
