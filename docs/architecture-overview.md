# oh-my-codebuddy Architecture Overview

## Module Diagram

```
                          ┌──────────────────────┐
                          │        CLI (omb)      │
                          │  setup/doctor/explore │
                          └──────────┬───────────┘
                                     │
                          ┌──────────┴───────────┐
                          │       Setup           │
                          │  config/skill/agents   │
                          └──────────┬───────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                       │
   ┌──────────┴───────────┐ ┌───────┴────────┐  ┌──────────┴───────────┐
   │   Team Runtime        │ │     State      │  │      AGENTS          │
   │  orchestrator/monitor │ │  MCP servers   │  │  overlay/worker mgmt │
   │  worker-bootstrap     │ │  session/mode  │  │  codebase-map        │
   │  dispatch/mailbox     │ │  memory/notepad│  │  explore-routing     │
   └──────────┬───────────┘ └───────┬────────┘  └──────────┬───────────┘
              │                      │                       │
              └──────────────────────┼───────────────────────┘
                                     │
                          ┌──────────┴───────────┐
                          │   Runtime Bridge      │
                          │  Rust binary (exec)   │
                          │  authority/backlog    │
                          │  dispatch/mailbox     │
                          └──────────────────────┘
```

## Module Boundaries

### CLI (`src/cli/`)
User-facing commands: `omb setup`, `omb doctor`, `omb explore`, `omb sparkshell`, `omb version`. Owns argument parsing and output formatting. Delegates to other modules for all substantive work.

### Setup (`src/cli/setup.ts`, `src/config/`, `src/agents/`)
Installation flow: generates config files, installs skills and agent prompts, writes AGENTS.md template. Owns the initial project scaffolding and never modifies runtime state.

### Team Runtime (`src/team/`)
Multi-agent orchestration: worker lifecycle, task assignment, scaling/rebalancing, dispatch, mailbox, monitoring, merge coordination. This is the largest module and owns:
- **Worker bootstrap**: AGENTS.md composition for workers, inbox generation, worktree management
- **Orchestrator**: Scan → decide → actuate → persist cycle
- **State**: Task/worker/mailbox/dispatch persistence and queries
- **Governance**: Policy normalization and defaults
- **Health**: Composite health assessment (heartbeat + tmux + audit log)
- **Scaling**: Worker pool management (add/remove/rebalance)

### State (`src/mcp/`, `src/hooks/session.ts`, `src/state/`)
Session lifecycle, mode state, project memory, and notepad. Exposed via MCP servers for agent tool access. Owns:
- **Session**: Start/end tracking, stale session detection (PID + identity validation)
- **Mode state**: Active skill/mode persistence with scope preference (root vs session)
- **Memory**: Project-level memory (tech stack, conventions, directives)
- **Notepad**: Working/priority/scratch notes with section-based access

### AGENTS Management (`src/hooks/agents-overlay.ts`, `src/hooks/codebase-map.ts`, `src/hooks/explore-routing.ts`)
Dynamic instruction injection: generates and applies session-specific context to AGENTS.md before each agent launch. Owns:
- **Session overlay**: Runtime marker-bounded section (modes, codebase map, compaction protocol)
- **Codebase map**: Directory/module structure for token-efficient exploration
- **Explore routing**: Advisory steering for `omb explore` vs normal path
- **Recovery**: Crash-safe cleanup via recovery ledger

### Runtime Bridge (`src/runtime/`)
Interface to the Rust `omx-runtime` binary. Owns authority, dispatch queue, mailbox, backlog, and replay cursor via `execFileSync`. All Rust-domain state is accessed through this bridge; TS never writes directly to Rust-owned files when the bridge is enabled.

### Hooks (`src/hooks/`)
CodeBuddy hook implementations: persistent-mode (blocks stop), think-mode (high-reasoning), pre-compact (state checkpoint), rules-injector (rule file discovery), todo-continuation (incomplete task detection).

### Pipeline (`src/pipeline/`)
Configurable execution pipeline: RALPLAN → team execution → ralph verification. Orchestrates multi-stage workflows with state persistence and resumption.

## Typical Call Chains

### 1. CLI Startup

```
main() → buildContext()
  ├── parse argv
  ├── loadConfig()
  └── dispatch(command)
        └── launchPipeline()
              ├── writeSessionStart(cwd, sessionId)
              │     └── ProcessIdentityAdapter.readIdentity(pid) → session.json
              ├── generateOverlay(cwd, sessionId)
              │     ├── readActiveModes()
              │     ├── generateCodebaseMap()
              │     ├── buildExploreRoutingGuidance()
              │     └── capBodyToMax(sections)
              └── applyOverlay(agentsMdPath, overlay)
                    └── withAgentsLock() → apply → release
```

### 2. Team Monitor Cycle

```
TeamOrchestrator.monitorLoop()
  ├── scanWorkers()
  │     └── checkWorkerHealth() → heartbeat + tmux liveness
  ├── decide()
  │     ├── evaluateTaskAssignments()
  │     └── rebalancePolicy.shouldRebalance()
  ├── actuate()
  │     ├── claimTask() / assignTask()
  │     ├── dispatchToWorker() → RuntimeBridge.execCommand(QueueDispatch)
  │     └── notifyWorker() → tmux send-keys
  └── persist()
        ├── writeTaskState()
        └── appendToLog()
```

### 3. State Write (Session Overlay)

```
applyOverlay(agentsMdPath, overlay, cwd)
  └── withAgentsLock(cwd, fn)
        ├── acquireLock()
        │     ├── mkdir(lockDir)
        │     └── writeFile(owner.json)
        ├── readFile(agentsMdPath)
        ├── stripOverlayContent(content)
        ├── writeFile(agentsMdPath, content + overlay)
        └── releaseLock()
              └── rm(lockDir, { recursive: true })
```

## Key Design Decisions

1. **Marker-bounded overlays**: AGENTS.md mutations use HTML comment markers (`<!-- OMB:RUNTIME:START/END -->`) for idempotent apply/strip cycles. This avoids corrupting user-authored content.

2. **mkdir-based locking**: File locks use `mkdir` (atomic on all platforms) with PID-aware stale detection. See `src/shared/locks/agents-lock.ts`.

3. **Process identity for staleness**: On Linux, session staleness is determined by `/proc/{pid}/stat` start ticks + cmdline, not just PID liveness. This prevents PID reuse from causing false negatives. See `src/runtime/process-identity.ts`.

4. **Rust/TS split authority**: The Rust runtime owns authority/lease/dispatch/mailbox state; TS owns UX/orchestration/AGENTS management. See ADR 0001.

5. **Three-category AGENTS ownership**: User original (never modified), session overlay (agents-overlay.ts), worker instructions (worker-bootstrap.ts). Single owner per category. See ADR 0003.

6. **Data-driven explore routing**: Routing decisions are driven by a rules table (`EXPLORE_ROUTING_RULES`) rather than inline regex, making them testable and extensible. See `src/hooks/explore-routing-rules.ts`.
