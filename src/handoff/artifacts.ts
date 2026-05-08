import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeAtomicFile } from "../shared/io/atomic-write.js";
import { buildHandoffId, type HandoffArtifactRecord, type HandoffRequest, isHandoffProvider } from "./contract.js";
import { collectHandoffContext, type HandoffContext } from "./context.js";
import { resolveHandoffPaths } from "./paths.js";
import { renderHandoffArtifact } from "./render.js";

export interface CreateHandoffArtifactResult {
  record: HandoffArtifactRecord;
  markdown: string;
  context: HandoffContext;
  warnings: string[];
}

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function isRecord(value: unknown): value is HandoffArtifactRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HandoffArtifactRecord>;
  return typeof candidate.id === "string"
    && typeof candidate.to_provider === "string"
    && typeof candidate.markdown_path === "string"
    && typeof candidate.json_path === "string";
}

function parseIndex(value: unknown): HandoffArtifactRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

export function readHandoffIndex(cwd: string): HandoffArtifactRecord[] {
  const paths = resolveHandoffPaths(cwd);
  try {
    return parseIndex(readJsonFile(paths.indexPath));
  } catch {
    return [];
  }
}

export function readLatestHandoffMarkdown(cwd: string): string | undefined {
  const paths = resolveHandoffPaths(cwd);
  if (!existsSync(paths.latestMarkdownPath)) return undefined;
  return readFileSync(paths.latestMarkdownPath, "utf-8");
}

function inferFromProvider(env: NodeJS.ProcessEnv = process.env): HandoffArtifactRecord["from_provider"] {
  const raw = String(env.OMB_LEADER_CLI ?? "").trim().toLowerCase();
  return isHandoffProvider(raw) ? raw : "unknown";
}

function inferMode(request: HandoffRequest, context: HandoffContext): HandoffRequest["mode"] {
  if (request.mode) return request.mode;
  for (const mode of ["autopilot", "ralph", "team"] as const) {
    if (context.active_modes.includes(mode)) return mode;
  }
  return "unknown";
}

async function writeText(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeAtomicFile(path, data);
}

export async function createHandoffArtifact(request: HandoffRequest): Promise<CreateHandoffArtifactResult> {
  const paths = resolveHandoffPaths(request.cwd);
  const now = new Date();
  const id = buildHandoffId(now);
  const context = await collectHandoffContext(request.cwd);
  const warnings = [...context.warnings];
  const record: HandoffArtifactRecord = {
    id,
    from_provider: request.from ?? inferFromProvider(),
    to_provider: request.to,
    cwd: context.cwd,
    mode: inferMode(request, context),
    reason: request.reason,
    task: request.task,
    markdown_path: paths.markdownPathFor(id),
    json_path: paths.jsonPathFor(id),
    created_at: now.toISOString(),
    status: "created",
  };
  const markdown = renderHandoffArtifact(record, context);

  if (request.dryRun) {
    return { record, markdown, context, warnings };
  }

  await mkdir(paths.artifactDir, { recursive: true });
  await mkdir(dirname(paths.statePath), { recursive: true });

  let existingIndex: HandoffArtifactRecord[] = [];
  try {
    existingIndex = readHandoffIndex(request.cwd);
    if (existsSync(paths.indexPath) && existingIndex.length === 0) {
      const parsed = readJsonFile(paths.indexPath);
      if (!Array.isArray(parsed)) warnings.push("Malformed handoff index; recreating index.json");
    }
  } catch {
    warnings.push("Malformed handoff index; recreating index.json");
  }

  await writeText(record.markdown_path, markdown);
  await writeText(record.json_path, JSON.stringify({ record, context, warnings }, null, 2));
  await writeText(paths.latestMarkdownPath, markdown);
  await writeText(paths.indexPath, JSON.stringify([...existingIndex, record], null, 2));
  await writeText(paths.statePath, JSON.stringify({ latest: record, updated_at: now.toISOString() }, null, 2));

  return { record, markdown, context, warnings };
}
