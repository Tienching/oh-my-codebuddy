/**
 * Unified error classification for the OMB CLI.
 *
 * Maps unknown errors to structured error kinds with
 * appropriate exit codes for consistent CLI error handling.
 */

export type CliErrorKind = "usage" | "environment" | "launch" | "runtime" | "partial_cleanup";

export interface ClassifiedError {
  kind: CliErrorKind;
  message: string;
  exitCode: number;
  detail?: string;
}

/**
 * Classify an unknown error into a structured CLI error.
 *
 * Uses heuristics on the error type and message to determine the
 * appropriate error kind and exit code. Falls back to "runtime"
 * for errors that don't match any known pattern.
 */
export function classifyCliError(error: unknown): ClassifiedError {
  if (!error) {
    return { kind: "runtime", message: "An unknown error occurred", exitCode: 1 };
  }

  if (error instanceof Error) {
    const message = error.message;

    // Usage errors
    if (
      message.includes("Missing setup scope") ||
      message.includes("Invalid setup scope") ||
      message.includes("Invalid reasoning mode") ||
      message.includes("Unknown command")
    ) {
      return { kind: "usage", message, exitCode: 1 };
    }

    // Environment errors
    if (
      message.includes("executable not found") ||
      message.includes("tmux was not found") ||
      message.includes("Unable to resolve OMB launcher")
    ) {
      return { kind: "environment", message, exitCode: 1 };
    }

    // Launch errors
    if (
      message.includes("failed to launch codebuddy") ||
      message.includes("failed to attach detached tmux session") ||
      message.includes("launch instructions file not found")
    ) {
      return { kind: "launch", message, exitCode: 1 };
    }

    // Check for exec failure with exit code
    const execError = error as NodeJS.ErrnoException & { status?: number | null; signal?: NodeJS.Signals | null };
    if (typeof execError.status === "number") {
      return { kind: "launch", message, exitCode: execError.status, detail: `Process exited with status ${execError.status}` };
    }
    if (typeof execError.signal === "string") {
      return { kind: "launch", message, exitCode: 1, detail: `Process killed by signal ${execError.signal}` };
    }

    // Permission / access errors
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      return { kind: "environment", message, exitCode: 1, detail: `Permission denied (code: ${code})` };
    }

    return { kind: "runtime", message, exitCode: 1 };
  }

  // String errors
  if (typeof error === "string") {
    return { kind: "runtime", message: error, exitCode: 1 };
  }

  return { kind: "runtime", message: String(error), exitCode: 1 };
}
