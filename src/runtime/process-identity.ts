/**
 * Process Identity Adapter for session staleness detection
 *
 * Provides platform-specific PID identity validation. On Linux, reads
 * /proc/{pid}/stat for start ticks and /proc/{pid}/cmdline for command
 * line to detect PID reuse. On non-Linux platforms, falls back to
 * simple PID liveness checks.
 *
 * Extracted from session.ts to enable testability and reuse.
 */

import { readFileSync } from "fs";

// ── Types ──────────────────────────────────────────────────────────────

export interface ProcessIdentity {
  /** Process start time in kernel ticks (Linux-specific). */
  startTicks: number;
  /** Process command line (null if unavailable). */
  cmdline: string | null;
}

export interface ProcessIdentityAdapter {
  /** Read identity information for a PID. Returns null if unavailable. */
  readIdentity(pid: number): ProcessIdentity | null;
  /** Check if a PID is alive (signal-safe check). */
  isPidAlive(pid: number): boolean;
}

// ── Linux adapter ──────────────────────────────────────────────────────

/**
 * Parse the start ticks field from /proc/{pid}/stat content.
 * Field 22 (0-indexed field 19 after the comm field) is starttime.
 */
export function parseLinuxProcStartTicks(statContent: string): number | null {
  const commandEnd = statContent.lastIndexOf(")");
  if (commandEnd === -1) return null;

  const remainder = statContent.slice(commandEnd + 1).trim();
  const fields = remainder.split(/\s+/);
  if (fields.length <= 19) return null;

  const startTicks = Number(fields[19]);
  return Number.isFinite(startTicks) ? startTicks : null;
}

/**
 * Normalize a command line string: collapse whitespace, trim.
 */
export function normalizeCmdline(cmdline: string | null | undefined): string | null {
  if (!cmdline) return null;
  const normalized = cmdline.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

export class LinuxProcessIdentityAdapter implements ProcessIdentityAdapter {
  readIdentity(pid: number): ProcessIdentity | null {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const startTicks = parseLinuxProcStartTicks(stat);
      if (startTicks == null) return null;

      let cmdline: string | null = null;
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8")
          .replace(/\u0000+/g, " ")
          .trim();
      } catch {
        cmdline = null;
      }

      return {
        startTicks,
        cmdline: normalizeCmdline(cmdline),
      };
    } catch {
      return null;
    }
  }

  isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

// ── Fallback adapter (non-Linux) ───────────────────────────────────────

export class FallbackProcessIdentityAdapter implements ProcessIdentityAdapter {
  readIdentity(_pid: number): null {
    // No identity validation possible on non-Linux platforms
    return null;
  }

  isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

// ── Adapter resolution ─────────────────────────────────────────────────

/**
 * Get the appropriate process identity adapter for the current platform.
 */
export function getProcessIdentityAdapter(
  platform: NodeJS.Platform = process.platform,
): ProcessIdentityAdapter {
  return platform === "linux"
    ? new LinuxProcessIdentityAdapter()
    : new FallbackProcessIdentityAdapter();
}
