import { appendFile, mkdir, stat, readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export type TeamDeliveryEventName =
  | 'mailbox_created'
  | 'dispatch_attempted'
  | 'dispatch_result'
  | 'delivered'
  | 'mark_delivered'
  | 'nudge_triggered';

export type TeamDeliveryResult =
  | 'created'
  | 'queued'
  | 'ok'
  | 'confirmed'
  | 'notified'
  | 'updated'
  | 'missing'
  | 'retry'
  | 'deferred'
  | 'sent'
  | 'failed';

export interface TeamDeliveryLogEvent {
  event: TeamDeliveryEventName;
  source: string;
  team: string;
  transport?: string;
  result?: TeamDeliveryResult;
  [key: string]: unknown;
}

const MAX_DELIVERY_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DELIVERY_LOG_AGE_DAYS = 14;
const MAX_STRING_VALUE_LENGTH = 4096;
const MAX_EXTRA_FIELDS = 32;

function normalizeTransport(transport: unknown): string | undefined {
  if (typeof transport !== 'string') return undefined;
  switch (transport) {
    case 'tmux_send_keys':
      return 'send-keys';
    case 'prompt_stdin':
      return 'prompt-stdin';
    default:
      return transport;
  }
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, candidate]) => candidate !== undefined),
  ) as T;
}

function redactSensitiveString(value: string): string {
  let result = value;
  result = result.replace(/Bearer\s+\S+/gi, '[REDACTED:bearer]');
  result = result.replace(/token[_-]?\s*[:=]\s*\S+/gi, '[REDACTED:token]');
  result = result.replace(/api[_-]?key\s*[:=]\s*\S+/gi, '[REDACTED:api_key]');
  return result;
}

function truncateString(value: unknown): unknown {
  if (typeof value === 'string') {
    const redacted = redactSensitiveString(value);
    return redacted.length > MAX_STRING_VALUE_LENGTH
      ? redacted.slice(0, MAX_STRING_VALUE_LENGTH) + '...[TRUNCATED]'
      : redacted;
  }
  return value;
}

function sanitizeEventFields(event: TeamDeliveryLogEvent): Record<string, unknown> {
  const knownKeys = new Set(['event', 'source', 'team', 'transport', 'result']);
  const entries = Object.entries(event);
  const limited = entries.slice(0, MAX_EXTRA_FIELDS + knownKeys.size);
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of limited) {
    if (typeof value === 'string') {
      sanitized[key] = truncateString(value);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(truncateString);
    } else if (value && typeof value === 'object') {
      sanitized[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, truncateString(v)]),
      );
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function teamDeliveryLogPath(logsDir: string, now: Date = new Date()): string {
  return join(logsDir, `team-delivery-${now.toISOString().slice(0, 10)}.jsonl`);
}

async function pruneOldDeliveryLogs(logsDir: string, now: Date = new Date()): Promise<void> {
  if (!existsSync(logsDir)) return;
  try {
    const entries = await readdir(logsDir);
    const prefix = 'team-delivery-';
    const cutoff = new Date(now.getTime() - MAX_DELIVERY_LOG_AGE_DAYS * 24 * 60 * 60 * 1000);
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.jsonl')) continue;
      try {
        const stats = await stat(join(logsDir, entry));
        if (stats.mtime < cutoff) {
          await unlink(join(logsDir, entry));
        }
      } catch { /* best-effort prune */ }
    }
  } catch { /* best-effort prune */ }
}

async function checkRotationNeeded(logsDir: string, now: Date): Promise<boolean> {
  const logPath = teamDeliveryLogPath(logsDir, now);
  if (!existsSync(logPath)) return false;
  try {
    const stats = await stat(logPath);
    return stats.size > MAX_DELIVERY_LOG_SIZE_BYTES;
  } catch {
    return false;
  }
}

export async function appendTeamDeliveryLog(logsDir: string, event: TeamDeliveryLogEvent): Promise<void> {
  const now = new Date();
  const sanitized = sanitizeEventFields(event);
  const entry = compactObject({
    timestamp: now.toISOString(),
    kind: 'team_delivery',
    ...sanitized,
    transport: normalizeTransport(event.transport),
  });

  try {
    await mkdir(logsDir, { recursive: true });
  } catch (error) {
    // mkdir failure is non-critical; appendFile will also fail, but we try
  }

  const logPath = teamDeliveryLogPath(logsDir, now);
  try {
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Write failure is non-critical for delivery logging — the delivery
    // itself already succeeded or was queued. Swallowing prevents
    // cascading failures in the caller.
    return;
  }

  // Prune old logs on every write (lightweight when nothing to prune)
  await pruneOldDeliveryLogs(logsDir, now);

  // If the current day's log is oversize, truncate it by removing it.
  // (Delivery logs are append-only audit trails; rotation = fresh start.)
  if (await checkRotationNeeded(logsDir, now)) {
    try {
      await unlink(logPath);
    } catch { /* rotation failure is non-critical */ }
  }
}

export async function appendTeamDeliveryLogForCwd(cwd: string, event: TeamDeliveryLogEvent): Promise<void> {
  await appendTeamDeliveryLog(join(cwd, '.omb', 'logs'), event);
}
