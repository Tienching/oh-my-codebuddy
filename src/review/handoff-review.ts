import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { HANDOFF_STATUSES, isHandoffProvider, type HandoffArtifactRecord } from "../handoff/contract.js";
import { readHandoffIndex } from "../handoff/artifacts.js";
import { resolveHandoffPaths } from "../handoff/paths.js";
import type { HandoffContext } from "../handoff/context.js";

export type HandoffReviewVerdict = "approve" | "reject" | "needs-human";
export type HandoffReviewCheckStatus = "pass" | "warn" | "fail";

export interface HandoffReviewCheck {
  name: string;
  status: HandoffReviewCheckStatus;
  message: string;
}

export interface ResolvedHandoffArtifact {
  record: HandoffArtifactRecord;
  context?: HandoffContext;
  warnings: string[];
  markdown: string;
  jsonPath: string;
  markdownPath: string;
}

export interface HandoffReviewResult {
  verdict: HandoffReviewVerdict;
  checks: HandoffReviewCheck[];
  risks: string[];
  required_fixes: string[];
  confidence: "low" | "medium" | "high";
  handoff: HandoffArtifactRecord;
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Handoff JSON is not an object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function resolvePathRef(cwd: string, ref: string): string {
  return isAbsolute(ref) ? ref : resolve(cwd, ref);
}

function isRecordLike(value: unknown): value is HandoffArtifactRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HandoffArtifactRecord>;
  return typeof candidate.id === "string"
    && typeof candidate.from_provider === "string"
    && typeof candidate.to_provider === "string"
    && typeof candidate.cwd === "string"
    && typeof candidate.markdown_path === "string"
    && typeof candidate.json_path === "string"
    && typeof candidate.created_at === "string"
    && typeof candidate.status === "string";
}

function isContextLike(value: unknown): value is HandoffContext {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HandoffContext>;
  return typeof candidate.cwd === "string"
    && typeof candidate.project_name === "string"
    && Array.isArray(candidate.changed_files)
    && Array.isArray(candidate.active_modes)
    && Array.isArray(candidate.plan_files)
    && Array.isArray(candidate.warnings);
}

export function resolveHandoffArtifactRef(cwd: string, ref = "latest"): ResolvedHandoffArtifact {
  const paths = resolveHandoffPaths(cwd);
  let jsonPath: string | undefined;

  if (ref === "latest") {
    const index = readHandoffIndex(cwd);
    const latest = index.at(-1);
    if (!latest) throw new Error("No latest handoff found. Run `omb handoff --to <provider>` first.");
    jsonPath = latest.json_path;
  } else if (ref.endsWith(".json") || ref.includes("/") || ref.includes("\\")) {
    jsonPath = resolvePathRef(cwd, ref);
  } else {
    const indexMatch = readHandoffIndex(cwd).find((entry) => entry.id === ref);
    jsonPath = indexMatch?.json_path ?? paths.jsonPathFor(ref);
  }

  if (!existsSync(jsonPath)) throw new Error(`Handoff JSON not found: ${jsonPath}`);
  const envelope = readJsonObject(jsonPath);
  const recordValue = envelope.record ?? envelope;
  if (!isRecordLike(recordValue)) throw new Error(`Handoff JSON is missing required record fields: ${jsonPath}`);
  const record = recordValue;
  const markdownPath = record.markdown_path ? resolvePathRef(cwd, record.markdown_path) : join(paths.artifactDir, `${record.id}.md`);
  if (!existsSync(markdownPath)) throw new Error(`Handoff markdown not found: ${markdownPath}`);
  const markdown = readFileSync(markdownPath, "utf-8");
  const context = isContextLike(envelope.context) ? envelope.context : undefined;
  const warnings = Array.isArray(envelope.warnings) ? envelope.warnings.map(String) : [];
  return { record, context, warnings, markdown, jsonPath, markdownPath };
}

function addCheck(checks: HandoffReviewCheck[], status: HandoffReviewCheckStatus, name: string, message: string): void {
  checks.push({ name, status, message });
}

function hasSections(markdown: string): boolean {
  const required = [
    "# OMB Provider Handoff",
    "## Handoff",
    "## Original / Current Task",
    "## Current Workspace",
    "## Changed Files",
    "## Git Status",
    "## Next Actions for Target Provider",
    "## Suggested Commands",
  ];
  return required.every((section) => markdown.includes(section));
}

export function reviewHandoff(artifact: ResolvedHandoffArtifact): HandoffReviewResult {
  const checks: HandoffReviewCheck[] = [];
  const risks: string[] = [];
  const requiredFixes: string[] = [];
  const { record, context, markdown } = artifact;

  if (isHandoffProvider(String(record.to_provider))) addCheck(checks, "pass", "target_provider", `Target provider is ${record.to_provider}.`);
  else {
    addCheck(checks, "fail", "target_provider", `Invalid target provider: ${String(record.to_provider)}`);
    requiredFixes.push("Regenerate the handoff with a valid target provider.");
  }

  if (record.from_provider === "unknown" || isHandoffProvider(String(record.from_provider))) addCheck(checks, "pass", "source_provider", `Source provider is ${record.from_provider}.`);
  else {
    addCheck(checks, "fail", "source_provider", `Invalid source provider: ${String(record.from_provider)}`);
    requiredFixes.push("Regenerate the handoff with a valid source provider or unknown.");
  }

  if ((HANDOFF_STATUSES as readonly string[]).includes(String(record.status))) addCheck(checks, "pass", "status", `Status is ${record.status}.`);
  else {
    addCheck(checks, "fail", "status", `Invalid handoff status: ${String(record.status)}`);
    requiredFixes.push("Regenerate the handoff with a valid status.");
  }

  if (hasSections(markdown)) addCheck(checks, "pass", "markdown_required_sections", "Markdown contains required handoff sections.");
  else {
    addCheck(checks, "fail", "markdown_required_sections", "Markdown is missing required handoff sections.");
    requiredFixes.push("Regenerate or repair the handoff markdown shape.");
  }

  if (context) addCheck(checks, "pass", "context_shape", "JSON artifact includes captured context.");
  else {
    addCheck(checks, "fail", "context_shape", "JSON artifact is missing captured context.");
    requiredFixes.push("Regenerate the handoff JSON so it includes workspace context.");
  }

  if (context?.git_status || context?.changed_files) addCheck(checks, "pass", "git_context", "Git status or changed-file context was captured.");
  else {
    addCheck(checks, "warn", "git_context", "No git status or changed-file context was captured.");
    risks.push("Target provider may need to run git status before editing.");
  }

  if (context?.session) addCheck(checks, "pass", "session_context", "Session context was captured.");
  else {
    addCheck(checks, "warn", "session_context", "No active session context was captured.");
    risks.push("No active OMB session context was captured; target provider should inspect .omb/state if needed.");
  }

  if (/Verification Evidence[\s\S]*Not yet collected/i.test(markdown)) {
    addCheck(checks, "warn", "verification_evidence", "Verification section is present but no evidence was collected by handoff.");
    risks.push("Verification evidence is not collected in this handoff; target provider must verify before claiming completion.");
  } else if (/## Verification Evidence/.test(markdown)) {
    addCheck(checks, "pass", "verification_evidence", "Verification section is present.");
  } else {
    addCheck(checks, "warn", "verification_evidence", "Verification section is missing.");
    risks.push("Verification evidence is missing from the handoff.");
  }

  const hasFail = checks.some((check) => check.status === "fail");
  return {
    verdict: hasFail ? "reject" : "approve",
    checks,
    risks,
    required_fixes: requiredFixes,
    confidence: hasFail ? "high" : risks.length > 0 ? "medium" : "high",
    handoff: record,
  };
}

export function renderHandoffReview(result: HandoffReviewResult): string {
  const lines = [
    `Verdict: ${result.verdict}`,
    `Handoff: ${result.handoff.id}`,
    `Route: ${result.handoff.from_provider} -> ${result.handoff.to_provider}`,
    `Confidence: ${result.confidence}`,
    "",
    "Checks:",
    ...result.checks.map((check) => `- [${check.status}] ${check.name}: ${check.message}`),
  ];
  if (result.risks.length > 0) lines.push("", "Risks:", ...result.risks.map((risk) => `- ${risk}`));
  if (result.required_fixes.length > 0) lines.push("", "Required fixes:", ...result.required_fixes.map((fix) => `- ${fix}`));
  return lines.join("\n");
}
