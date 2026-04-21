/**
 * Cleanup and rollback for the OMB CLI.
 *
 * Provides a structured cleanup plan that accumulates actions
 * during a session and executes them on exit.
 */

export interface CleanupAction {
  type: "pane" | "worktree" | "agents" | "session" | "overlay" | "state";
  description: string;
  execute: () => Promise<void>;
}

export interface CleanupResult {
  succeeded: string[];
  failed: Array<{ description: string; error: Error }>;
}

export class CleanupPlan {
  private actions: CleanupAction[] = [];

  register(action: CleanupAction): void {
    this.actions.push(action);
  }

  async executeAll(): Promise<CleanupResult> {
    const succeeded: string[] = [];
    const failed: Array<{ description: string; error: Error }> = [];

    // Execute in reverse registration order (LIFO) so that
    // later-stage cleanup runs before earlier-stage cleanup.
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const action = this.actions[i];
      try {
        await action.execute();
        succeeded.push(action.description);
      } catch (err) {
        failed.push({
          description: action.description,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    return { succeeded, failed };
  }

  get pendingCount(): number {
    return this.actions.length;
  }
}
