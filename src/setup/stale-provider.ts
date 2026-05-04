/**
 * Detects stale project-scope provider residue.
 *
 * Background (architect-review M3 / QA Matrix E, 2026-04-30):
 * When a user runs `omb setup --provider <A> --scope project`, then later
 * switches to `--provider <B> --scope project` without first running
 * `omb uninstall --provider <A>`, the `.codebuddy/` / `.codex/` / `.claude/`
 * directory from provider A stays behind. doctor then reads
 * `setup-scope.json.provider` (which was overwritten to B) and only inspects
 * B's directory, so the stale A install is invisible.
 *
 * OMB cannot auto-delete these directories (they may contain user-touched
 * files OMB does not own, and the shared-ownership contract forbids
 * destructive cleanup without explicit user consent). Instead, setup and
 * doctor emit a warning telling the user to run the appropriate
 * `omb uninstall --provider <stale>` to clean up.
 *
 * Implementation notes:
 * - Only checks project scope. `~/.<provider>/` user-scope directories are
 *   routinely shared with non-OMB installs (a user may have codebuddy CLI
 *   installed for their own use), so flagging those would produce noisy
 *   false positives.
 * - "Residue" = the `<provider-dir>/` exists AND contains something
 *   OMB-authored (hooks file, prompts/, skills/, agents/, or AGENTS.md /
 *   .omb-config.json). Naked empty directories or user-created
 *   `.claude/settings.json` alone are not flagged, since they are not
 *   OMB's to clean up.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type ProviderDirName = ".codebuddy" | ".codex" | ".claude";

const PROVIDER_DIR_NAMES: readonly ProviderDirName[] = [
  ".codebuddy",
  ".codex",
  ".claude",
];

/**
 * Signals that indicate a directory was populated by `omb setup` rather than
 * just being touched by another tool. At least one must be present for a
 * residue to count.
 *
 * The claude branch uses `hooks/hooks.json` (subdirectory) per PRD; the
 * others use the flat layout.
 */
function ombAuthoredMarkersForProvider(providerDir: ProviderDirName): string[] {
  const markers: string[] = [
    ".omb-config.json",
    "AGENTS.md",
    "prompts",
    "skills",
    "agents",
  ];
  if (providerDir === ".claude") {
    markers.push(join("hooks", "hooks.json"));
  } else {
    markers.push("hooks.json");
  }
  return markers;
}

export interface StaleProviderResidue {
  providerDirName: ProviderDirName;
  absPath: string;
  /** Which OMB-authored markers were found inside. */
  matchedMarkers: string[];
}

/**
 * Return the set of project-scope provider directories that contain
 * OMB-authored markers but are NOT the currently-active provider.
 *
 * `activeProviderDirNames` should be the directory names that the current
 * setup run is about to write/refresh (e.g. [".claude"] for
 * `--provider claude`; [".codebuddy", ".codex"] for `--provider both`;
 * [".codebuddy", ".codex", ".claude"] for `--provider all`). Any provider
 * directory NOT in this set but containing OMB markers is reported.
 *
 * Empty directories and directories without any OMB marker return no
 * residue (shared-ownership: OMB does not claim files it did not author).
 */
export function detectStaleProjectProviderResidue(
  projectRoot: string,
  activeProviderDirNames: readonly ProviderDirName[],
): StaleProviderResidue[] {
  const active = new Set<ProviderDirName>(activeProviderDirNames);
  const residues: StaleProviderResidue[] = [];
  for (const dirName of PROVIDER_DIR_NAMES) {
    if (active.has(dirName)) continue;
    const absPath = join(projectRoot, dirName);
    if (!existsSync(absPath)) continue;
    const matched = ombAuthoredMarkersForProvider(dirName).filter((marker) =>
      existsSync(join(absPath, marker)),
    );
    if (matched.length === 0) continue;
    residues.push({
      providerDirName: dirName,
      absPath,
      matchedMarkers: matched,
    });
  }
  return residues;
}

/**
 * Map a residue directory name back to the provider flag users pass on the
 * command line. Used in remediation hints (`omb uninstall --provider X`).
 */
export function providerDirNameToFlag(dirName: ProviderDirName): string {
  switch (dirName) {
    case ".codebuddy":
      return "codebuddy";
    case ".codex":
      return "codex";
    case ".claude":
      return "claude";
  }
}

/**
 * Human-readable summary of a residue list, suitable for doctor / setup output.
 * Returns `null` when there's no residue to report.
 */
export function formatStaleProviderResidueHint(
  residues: readonly StaleProviderResidue[],
): string | null {
  if (residues.length === 0) return null;
  const lines = residues.map((r) => {
    const flag = providerDirNameToFlag(r.providerDirName);
    return `${r.providerDirName}/ contains OMB artifacts (${r.matchedMarkers.join(", ")}); run "omb uninstall --provider ${flag} --scope project" to clean up`;
  });
  return lines.join("; ");
}
