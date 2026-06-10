/**
 * Size limits for team state text fields.
 * Override via env vars: OMB_MAX_EVENT_REASON_LENGTH, etc.
 */
export const STATE_TEXT_LIMITS = {
  MAX_EVENT_REASON_LENGTH: parseInt(process.env.OMB_MAX_EVENT_REASON_LENGTH || '4096', 10),
  MAX_EVENT_METADATA_JSON_BYTES: parseInt(process.env.OMB_MAX_EVENT_METADATA_JSON_BYTES || '32768', 10),
  MAX_MAILBOX_BODY_LENGTH: parseInt(process.env.OMB_MAX_MAILBOX_BODY_LENGTH || '65536', 10),
  MAX_TRIGGER_MESSAGE_LENGTH: parseInt(process.env.OMB_MAX_TRIGGER_MESSAGE_LENGTH || '16384', 10),
  MAX_DISPATCH_REASON_LENGTH: parseInt(process.env.OMB_MAX_DISPATCH_REASON_LENGTH || '4096', 10),
  MAX_AUDIT_DETAILS_LENGTH: parseInt(process.env.OMB_MAX_AUDIT_DETAILS_LENGTH || '8192', 10),
} as const;

export interface TruncationInfo {
  truncated: boolean;
  original_bytes: number;
}

/**
 * Truncate text to maxLen, preserving a truncation marker.
 */
export function safeStateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const marker = `\n...[truncated: ${text.length - maxLen + 30} chars omitted]`;
  return text.slice(0, maxLen - marker.length) + marker;
}

/**
 * Truncate and stringify metadata, with depth and size limits.
 */
export function safeStateMetadata(
  metadata: Record<string, unknown> | undefined,
  maxBytes: number,
): { value: Record<string, unknown> | undefined; info: TruncationInfo } {
  if (!metadata) return { value: undefined, info: { truncated: false, original_bytes: 0 } };

  const json = JSON.stringify(metadata);
  const originalBytes = Buffer.byteLength(json, 'utf8');

  if (originalBytes <= maxBytes) {
    return { value: metadata, info: { truncated: false, original_bytes: originalBytes } };
  }

  // Truncate by removing deepest keys first - simple approach: just truncate the string
  const marker = `"truncated":true,"original_bytes":${originalBytes}`;
  const truncated = json.slice(0, maxBytes - marker.length - 2) + ',' + marker + '}';
  try {
    return { value: JSON.parse(truncated), info: { truncated: true, original_bytes: originalBytes } };
  } catch {
    // If truncated JSON is invalid, return a minimal object
    return {
      value: { truncated: true, original_bytes: originalBytes, error: 'metadata_too_large' },
      info: { truncated: true, original_bytes: originalBytes },
    };
  }
}

/**
 * Common patterns for API keys, tokens, and secrets.
 * Redacts matching values to [REDACTED:<type>].
 */
const SECRET_PATTERNS = [
  // Common env var names for secrets
  { pattern: /(["']?(?:api[_-]?key|token|secret|password|auth|credential|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*["'])([^"']{8,})(["'])/gi, type: 'key' },
  // Bearer tokens
  { pattern: /(Bearer\s+)([A-Za-z0-9\-._~+/]+=*)/gi, type: 'bearer' },
  // Generic hex/base64 keys (32+ chars that look like secrets)
  { pattern: /(["']?(?:sk|pk|key|token|secret)_[a-z0-9_]+["']?\s*[:=]\s*["'])([A-Za-z0-9+/=_\-]{24,})(["'])/gi, type: 'apikey' },
];

/**
 * Redact common secret patterns from text.
 * Best-effort; not a substitute for proper secret management.
 */
export function redactSensitiveValues(text: string): string {
  let result = text;
  for (const { pattern, type } of SECRET_PATTERNS) {
    result = result.replace(pattern, `$1[REDACTED:${type}]$3`);
  }
  return result;
}

/**
 * Redact secrets from metadata values (recursive, shallow scan of string values).
 */
export function redactMetadataSecrets(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string') {
      result[key] = redactSensitiveValues(value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = redactMetadataSecrets(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
