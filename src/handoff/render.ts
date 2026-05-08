import type { HandoffArtifactRecord, HandoffProvider } from "./contract.js";
import type { HandoffContext } from "./context.js";

function bulletList(values: string[], empty = "None detected."): string {
  if (values.length === 0) return empty;
  return values.map((value) => `- ${value}`).join("\n");
}

function fenced(value: string | undefined, empty = "None detected."): string {
  const text = value?.trim();
  if (!text) return empty;
  return `\`\`\`text\n${text}\n\`\`\``;
}

function sanitizeDiffSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const safeLines = value
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(
        trimmed.startsWith("diff --git")
        || trimmed.startsWith("@@")
        || trimmed.startsWith("+++")
        || trimmed.startsWith("---")
        || trimmed.startsWith("+")
        || trimmed.startsWith("-")
      );
    });
  return safeLines.join("\n").trim() || "Full diff content omitted; run git diff --stat or inspect changed files locally.";
}

function suggestedCommand(to: HandoffProvider): string {
  if (to === "gemini") return "omb review --with gemini --handoff latest";
  return `omb --leader-cli ${to}`;
}

function suggestedCommands(to: HandoffProvider): string[] {
  if (to === "gemini") {
    return [
      "omb review --with gemini --handoff latest",
      "omb handoff show latest",
    ];
  }
  return [
    `omb --leader-cli ${to}`,
    `omb exec --leader-cli ${to} "$(cat .omb/handoffs/latest.md)"`,
    "omb handoff show latest",
  ];
}

export function renderHandoffArtifact(record: HandoffArtifactRecord, context: HandoffContext): string {
  const warnings = context.warnings.length > 0 ? `\n## Warnings\n${bulletList(context.warnings)}\n` : "";
  const sessionSummary = context.session ? JSON.stringify(context.session, null, 2) : undefined;
  const commands = suggestedCommands(record.to_provider).map((command) => `- \`${command}\``).join("\n");

  return `# OMB Provider Handoff

## Handoff
- From: ${record.from_provider}
- To: ${record.to_provider}
- Reason: ${record.reason ?? "Not specified"}
- Mode: ${record.mode ?? "unknown"}
- Created: ${record.created_at}
- Artifact ID: ${record.id}

## Original / Current Task
${record.task ?? "Not specified. Inspect workspace state and plans before editing."}

## Current Workspace
- Project: ${context.project_name}
- CWD: ${context.cwd}
- Branch: ${context.branch ?? "unknown"}

## Active OMB State Summary
- Active modes: ${context.active_modes.length > 0 ? context.active_modes.join(", ") : "none detected"}
- Recent plan files:
${bulletList(context.plan_files, "No .omb plan files detected.")}

${fenced(sessionSummary, "No session state detected.")}

## Changed Files
${bulletList(context.changed_files)}

## Git Status
${fenced(context.git_status)}

## Diff Summary
${fenced(sanitizeDiffSummary(context.diff_summary), "No diff summary detected.")}
${warnings}
## Verification Evidence
- Not yet collected by handoff command unless provided.

## Next Actions for Target Provider
1. Read this handoff.
2. Inspect mentioned files before editing.
3. Do not repeat completed work.
4. Verify with project tests before claiming completion.
5. Suggested next command: \`${suggestedCommand(record.to_provider)}\`

## Suggested Commands
${commands}
`;
}
