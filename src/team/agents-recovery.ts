/**
 * Recovery Ledger for AGENTS.md mutations
 *
 * Records every AGENTS.md overlay application so that after a crash,
 * stale overlays can be detected and cleaned up. Each entry tracks the
 * original file state and the owning process/session so that reconciliation
 * can safely restore the file when the owner is dead.
 *
 * The ledger is stored at `.omb/state/agents-recovery-ledger.json`.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { createHash } from "crypto";

// ── Types ──────────────────────────────────────────────────────────────

export interface RecoveryEntry {
  /** Absolute path to the file that was modified. */
  path: string;
  /** Whether the original file existed before mutation. */
  originalExists: boolean;
  /** SHA-256 hash of the original file content (null if file didn't exist). */
  originalHash: string | null;
  /** Whether git skip-worktree was applied to the file. */
  skipWorktree: boolean;
  /** ISO timestamp when the mutation was applied. */
  generatedAt: string;
  /** PID of the process that owns this mutation. */
  ownerPid: number;
  /** Session ID of the owning process. */
  ownerSession: string;
}

export interface ReconciliationResult {
  /** Entries that were reconciled (owner dead, overlay stripped). */
  reconciled: RecoveryEntry[];
  /** Entries still owned by live processes (skipped). */
  skipped: RecoveryEntry[];
  /** Errors encountered during reconciliation. */
  errors: Array<{ path: string; error: string }>;
}

interface LedgerData {
  entries: RecoveryEntry[];
}

const LEDGER_FILENAME = "agents-recovery-ledger.json";

// ── Helpers ────────────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function hashContent(content: string): Promise<string> {
  return createHash("sha256").update(content).digest("hex");
}

// ── RecoveryLedger ─────────────────────────────────────────────────────

export class RecoveryLedger {
  private entries: RecoveryEntry[] = [];
  private cwd: string = "";

  /**
   * Load the ledger from disk for the given working directory.
   * If no ledger exists, starts with an empty entry list.
   */
  async load(cwd: string): Promise<void> {
    this.cwd = cwd;
    const ledgerPath = this.ledgerPath();
    if (!existsSync(ledgerPath)) {
      this.entries = [];
      return;
    }

    try {
      const raw = await readFile(ledgerPath, "utf-8");
      const data = JSON.parse(raw) as LedgerData;
      this.entries = Array.isArray(data.entries) ? data.entries : [];
    } catch {
      this.entries = [];
    }
  }

  /**
   * Record a mutation entry. Call this BEFORE applying the overlay
   * so that the original file state is captured.
   */
  record(entry: RecoveryEntry): void {
    // Remove any existing entry for the same path (latest wins)
    this.entries = this.entries.filter((e) => e.path !== entry.path);
    this.entries.push(entry);
  }

  /**
   * Build a recovery entry by reading the current state of a file.
   * Convenience method that computes hash and exists flag.
   */
  async recordFromFile(
    filePath: string,
    options: {
      ownerPid: number;
      ownerSession: string;
      skipWorktree: boolean;
    },
  ): Promise<void> {
    const originalExists = existsSync(filePath);
    let originalHash: string | null = null;

    if (originalExists) {
      try {
        const content = await readFile(filePath, "utf-8");
        originalHash = await hashContent(content);
      } catch {
        originalHash = null;
      }
    }

    this.record({
      path: filePath,
      originalExists,
      originalHash,
      skipWorktree: options.skipWorktree,
      generatedAt: new Date().toISOString(),
      ownerPid: options.ownerPid,
      ownerSession: options.ownerSession,
    });
  }

  /**
   * Reconcile the ledger: for entries whose owner is dead,
   * strip the overlay and restore the original state.
   *
   * Returns a summary of what was done.
   */
  async reconcile(cwd: string): Promise<ReconciliationResult> {
    const result: ReconciliationResult = {
      reconciled: [],
      skipped: [],
      errors: [],
    };

    const remaining: RecoveryEntry[] = [];

    for (const entry of this.entries) {
      if (isPidAlive(entry.ownerPid)) {
        result.skipped.push(entry);
        remaining.push(entry);
        continue;
      }

      // Owner is dead — attempt recovery
      try {
        const fileExists = existsSync(entry.path);
        if (!fileExists && !entry.originalExists) {
          // File was never there and isn't now — nothing to do
          result.reconciled.push(entry);
          continue;
        }

        if (entry.originalExists && entry.originalHash) {
          // Verify current content — if hash matches original, overlay
          // was already stripped (e.g. by clean shutdown)
          if (fileExists) {
            const currentContent = await readFile(entry.path, "utf-8");
            const currentHash = await hashContent(currentContent);

            if (currentHash === entry.originalHash) {
              // Already restored — just clean up the entry
              result.reconciled.push(entry);
              continue;
            }
          }

          // File has been modified — strip overlay markers if present
          if (fileExists) {
            const content = await readFile(entry.path, "utf-8");
            const stripped = stripAllOverlayMarkers(content);
            await writeFile(entry.path, stripped, "utf-8");
          }
        } else if (!entry.originalExists && fileExists) {
          // File was created by the overlay — remove it
          const { unlink } = await import("fs/promises");
          await unlink(entry.path).catch(() => {});
        }

        result.reconciled.push(entry);
      } catch (err) {
        result.errors.push({
          path: entry.path,
          error: err instanceof Error ? err.message : String(err),
        });
        remaining.push(entry); // Keep entry for manual recovery
      }
    }

    this.entries = remaining;
    return result;
  }

  /**
   * Persist the ledger to disk.
   */
  async save(cwd?: string): Promise<void> {
    const dir = cwd ?? this.cwd;
    if (!dir) throw new Error("RecoveryLedger: no cwd set");

    const ledgerPath = this.ledgerPath(dir);
    await mkdir(dirname(ledgerPath), { recursive: true });

    const data: LedgerData = { entries: this.entries };
    await writeFile(ledgerPath, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Get the current entries (read-only view).
   */
  getEntries(): ReadonlyArray<RecoveryEntry> {
    return this.entries;
  }

  /**
   * Remove a specific entry by path (after successful cleanup).
   */
  removeEntry(filePath: string): void {
    this.entries = this.entries.filter((e) => e.path !== filePath);
  }

  private ledgerPath(cwd?: string): string {
    return join(cwd ?? this.cwd, ".omb", "state", LEDGER_FILENAME);
  }
}

// ── Marker stripping ───────────────────────────────────────────────────

const OVERLAY_MARKERS = [
  { start: "<!-- OMB:RUNTIME:START -->", end: "<!-- OMB:RUNTIME:END -->" },
  { start: "<!-- OMX:TEAM:WORKER:START -->", end: "<!-- OMX:TEAM:WORKER:END -->" },
  { start: "<!-- OMB:TEAM:WORKER:START -->", end: "<!-- OMB:TEAM:WORKER:END -->" },
];

/**
 * Strip all known overlay markers from AGENTS.md content.
 * This is used during crash recovery when we don't know which
 * overlay was applied.
 */
function stripAllOverlayMarkers(content: string): string {
  let result = content;

  for (const { start, end } of OVERLAY_MARKERS) {
    let iterations = 0;
    while (iterations < 50) {
      const startIdx = result.indexOf(start);
      if (startIdx < 0) break;

      const endIdx = result.indexOf(end, startIdx);
      if (endIdx < 0) {
        // Malformed — remove from start marker to end of file
        result = result.slice(0, startIdx).trimEnd() + "\n";
        break;
      }

      const before = result.slice(0, startIdx).trimEnd();
      const after = result.slice(endIdx + end.length).trimStart();
      result = after ? before + "\n" + after : before + "\n";
      iterations++;
    }
  }

  return result;
}
