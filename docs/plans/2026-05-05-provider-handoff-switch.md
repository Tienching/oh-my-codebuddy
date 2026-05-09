# Provider Handoff and Switch Implementation Plan

> **For Hermes:** Use Codex/OMX autopilot to implement this plan, then independently verify with build, targeted tests, lint, catalog check, and an isolated HOME dogfood where relevant.

**Goal:** Add a safe cross-provider handoff foundation to OMB so active work can be summarized for another provider, reviewed by another provider, and later switched to another leader without pretending to hot-swap an existing CLI process.

**Architecture:** Start with an artifact-first design: `omb handoff` generates provider-neutral markdown/JSON artifacts under `.omb/handoffs/` and `.omb/state/handoff-state.json`. Then add `omb review` as a thin layer over existing provider ask behavior. Only after the artifact contract is stable, add `omb switch` as a safe launcher that creates a handoff and starts a new leader using the existing `--leader-cli` launch pipeline. Do not migrate full provider transcripts or mutate active provider internals in the first implementation.

**Tech Stack:** TypeScript ESM, Node built-in test runner, existing OMB CLI modules, existing `.omb` state paths, existing provider-aware launch/setup/doctor helpers.

---

## Non-negotiable constraints

- Do **not** commit or push unless explicitly asked later.
- Keep changes small and reversible.
- No new runtime dependencies.
- Do not modify real `~/.codebuddy`, `~/.codex`, or `~/.claude` during tests; use temporary `HOME` for setup/doctor dogfood.
- Do not auto-kill old tmux sessions in `switch` MVP.
- Do not treat provider handoff as a terminal failure outcome in MVP.
- Default handoff content must be a summary, not a full unbounded diff/transcript dump.
- Any provider launch path must preserve provider env isolation (`CODEBUDDY_HOME`, `CODEX_HOME`, `CLAUDE_HOME`) and avoid leaking one provider's env into another.

---

## Existing seams to use

- CLI registration/help: `src/cli/index.ts`
- Existing provider launch: `src/cli/runtime/launch-pipeline.ts`
  - `LeaderCli = "codebuddy" | "codex" | "claude"`
  - `parseLeaderCliValue()`
  - `normalizeLeaderLaunchArgs()`
  - `translateLeaderExecArgs()`
  - `translateLeaderResumeArgs()`
  - `buildProviderLeaderEnv()`
  - `providerHomeEnv()`
  - `launchWithHud()` / `execWithOverlay()`
- Existing ask provider entry: `src/cli/ask.ts`
- Existing session state: `src/hooks/session.ts`
- State paths: `src/mcp/state-paths.ts`
- CLI state parity: `src/state/operations.ts` and `src/cli/state.ts`
- Team provider workers: `src/team/tmux-session.ts`
  - `TeamWorkerCli = 'codex' | 'claude' | 'gemini' | 'codebuddy'`
- Current package scripts: `npm run build`, `npm test`, `npm run lint`, `npm run catalog:check`

---

## Phase 1 — Provider-neutral handoff artifacts

### Task 1: Create handoff type contract

**Objective:** Define a small provider-neutral handoff model that can support handoff, review, and future switch without adding runtime coupling.

**Files:**
- Create: `src/handoff/contract.ts`
- Test: `src/handoff/__tests__/contract.test.ts`

**Implementation notes:**

Define:

```ts
export const HANDOFF_PROVIDERS = ["codebuddy", "codex", "claude", "gemini"] as const;
export type HandoffProvider = (typeof HANDOFF_PROVIDERS)[number];

export const HANDOFF_STATUSES = ["created", "reviewed", "launched", "completed", "abandoned"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export interface HandoffRequest {
  to: HandoffProvider;
  from?: HandoffProvider;
  reason?: string;
  task?: string;
  cwd: string;
  mode?: "solo" | "ralph" | "team" | "autopilot" | "unknown";
  dryRun?: boolean;
  includeDiff?: "none" | "summary" | "full";
}

export interface HandoffArtifactRecord {
  id: string;
  from_provider: HandoffProvider | "unknown";
  to_provider: HandoffProvider;
  cwd: string;
  mode: HandoffRequest["mode"];
  reason?: string;
  task?: string;
  markdown_path: string;
  json_path: string;
  created_at: string;
  status: HandoffStatus;
}
```

Add helpers:

- `isHandoffProvider(value: string): value is HandoffProvider`
- `parseHandoffProvider(value: string, flagName?: string): HandoffProvider`
- `buildHandoffId(now?: Date): string`

**Tests:**

- valid providers parse
- invalid provider throws message listing valid providers
- handoff id is stable shape, e.g. `handoff-YYYYMMDD-HHMMSS-*`

---

### Task 2: Build handoff path helpers

**Objective:** Centralize artifact paths and keep all generated handoff state under `.omb`.

**Files:**
- Create: `src/handoff/paths.ts`
- Test: `src/handoff/__tests__/paths.test.ts`

**Implementation notes:**

Expose:

```ts
export interface HandoffPaths {
  rootDir: string;
  artifactDir: string;
  indexPath: string;
  latestMarkdownPath: string;
  statePath: string;
  markdownPathFor(id: string): string;
  jsonPathFor(id: string): string;
}

export function resolveHandoffPaths(cwd: string): HandoffPaths;
```

Expected paths:

```text
.omb/handoffs/
.omb/handoffs/index.json
.omb/handoffs/latest.md
.omb/state/handoff-state.json
.omb/handoffs/<id>.md
.omb/handoffs/<id>.json
```

Use existing state path helpers if straightforward; otherwise use `join(cwd, ".omb", ...)` and keep it simple.

**Tests:**

- resolves paths inside cwd
- does not use HOME
- latest path is stable

---

### Task 3: Implement context collection with safe fallbacks

**Objective:** Collect enough context for a useful handoff without requiring an active OMB session.

**Files:**
- Create: `src/handoff/context.ts`
- Test: `src/handoff/__tests__/context.test.ts`

**Implementation notes:**

Collect:

- cwd basename
- current branch via git when available
- git status short
- changed file list
- diff summary by default, not full diff
- `.omb/state/session.json` if present
- simple active mode hints by checking likely files:
  - `.omb/state/autopilot.json`
  - `.omb/state/ralph/`
  - `.omb/state/team/`
- recent plan file names under `.omb/plans/`

Do not fail if git or `.omb` is absent. Return warnings instead.

Suggested shape:

```ts
export interface HandoffContext {
  cwd: string;
  project_name: string;
  branch?: string;
  git_status?: string;
  changed_files: string[];
  diff_summary?: string;
  session?: Record<string, unknown>;
  active_modes: string[];
  plan_files: string[];
  warnings: string[];
}
```

Use child process `git` commands with bounded output:

- `git rev-parse --abbrev-ref HEAD`
- `git status --short --branch`
- `git diff --stat`

**Tests:**

- no git repo returns warnings but no throw
- git repo with changes includes changed files
- existing `.omb/state/session.json` is included
- output is bounded if command returns too much text

---

### Task 4: Render handoff markdown and JSON

**Objective:** Produce a provider-specific but provider-neutral handoff document that another provider can consume as first context.

**Files:**
- Create: `src/handoff/render.ts`
- Test: `src/handoff/__tests__/render.test.ts`

**Markdown sections:**

```md
# OMB Provider Handoff

## Handoff
- From: ...
- To: ...
- Reason: ...
- Mode: ...
- Created: ...

## Original / Current Task
...

## Current Workspace
...

## Active OMB State Summary
...

## Changed Files
...

## Git Status
...

## Verification Evidence
- Not yet collected by handoff command unless provided.

## Next Actions for Target Provider
1. Read this handoff.
2. Inspect mentioned files before editing.
3. Do not repeat completed work.
4. Verify with project tests before claiming completion.

## Suggested Commands
...
```

Provider-specific suggested commands:

- codebuddy: `omb --leader-cli codebuddy --handoff latest` once implemented, or `omb exec --leader-cli codebuddy "$(cat .omb/handoffs/latest.md)"`
- codex: `omb --leader-cli codex ...`
- claude: `omb --leader-cli claude ...`
- gemini: `omb review --with gemini --handoff latest` because Gemini is not currently a leader provider.

**Tests:**

- renders from/to/reason/task
- includes warnings if present
- suggests non-leader behavior for gemini
- does not include full diff unless explicitly requested in future

---

### Task 5: Implement handoff artifact writer

**Objective:** Write handoff markdown, JSON record, latest link/copy, index, and state file atomically enough for CLI usage.

**Files:**
- Create: `src/handoff/artifacts.ts`
- Test: `src/handoff/__tests__/artifacts.test.ts`

**Implementation notes:**

Expose:

```ts
export async function createHandoffArtifact(request: HandoffRequest): Promise<HandoffArtifactRecord>;
export function readHandoffIndex(cwd: string): HandoffArtifactRecord[];
export function readLatestHandoffMarkdown(cwd: string): string | undefined;
```

Behavior:

- Ensure directories exist.
- Write `<id>.md`.
- Write `<id>.json`.
- Write/copy `latest.md`.
- Append/update `index.json` as array, newest last or first but be consistent.
- Write `.omb/state/handoff-state.json` with latest record.
- In `dryRun`, return record + rendered markdown but do not write files. If return shape needs markdown, add a separate result type.

**Tests:**

- creates all files
- updates latest
- preserves existing index entries
- dry-run writes nothing
- malformed existing index does not crash; warn and recreate or back up simply

---

## Phase 2 — `omb handoff` CLI

### Task 6: Add `src/cli/handoff.ts`

**Objective:** Expose artifact creation and inspection through a CLI command.

**Files:**
- Create: `src/cli/handoff.ts`
- Test: `src/cli/__tests__/handoff.test.ts`

**CLI forms:**

```bash
omb handoff --to claude
omb handoff claude
omb handoff --to codex --reason "test repair"
omb handoff --to claude --task "continue payment webhook work"
omb handoff --to claude --dry-run
omb handoff list
omb handoff show latest
```

Parsing rules:

- `omb handoff claude` equals `--to claude`.
- `--to` is required for creation.
- `list` prints index summary.
- `show latest` prints latest markdown.
- Unknown provider fails with valid provider list.

Output example:

```text
Created handoff: .omb/handoffs/handoff-20260505-010203-codebuddy-to-claude.md
Latest: .omb/handoffs/latest.md
Next: omb --leader-cli claude
```

**Tests:**

- create with positional provider
- create with `--to`
- dry-run prints but writes nothing
- list on empty repo returns friendly message
- show latest missing returns non-zero/friendly error

---

### Task 7: Register `handoff` in top-level CLI and help

**Objective:** Make `omb handoff` discoverable and routed.

**Files:**
- Modify: `src/cli/index.ts`
- Test: update existing CLI routing/help tests or add assertions in `src/cli/__tests__/handoff.test.ts`

**Implementation notes:**

- Import `handoffCommand`.
- Add `handoff` to help text near `ask` / `resume` / `state`.
- Add command dispatch branch.
- Include local help if command framework supports it.

**Tests:**

- `resolveCliInvocation(["handoff", ...])` routes command.
- `omb help` contains `omb handoff`.

---

## Phase 3 — Cross-provider review built on handoff

### Task 8: Add review contract and renderer

**Objective:** Define review artifact format before shelling out to external providers.

**Files:**
- Create: `src/review/contract.ts`
- Create: `src/review/render.ts`
- Test: `src/review/__tests__/render.test.ts`

**Review providers:**

Start with providers currently supported by `ask`: `claude | gemini`.

Suggested review prompt:

```md
You are reviewing an OMB handoff artifact.
Return:
- verdict: approve | reject | needs-human
- risks
- required_fixes
- confidence
Cite evidence from the handoff, git status, or test output. Do not invent files.
```

**Tests:**

- renders verdict instructions
- includes handoff content
- rejects unsupported review provider unless intentionally added

---

### Task 9: Add `omb review --with <provider>`

**Objective:** Provide a first-class cross-provider review command that uses latest handoff by default.

**Files:**
- Create: `src/cli/review.ts`
- Modify: `src/cli/index.ts`
- Test: `src/cli/__tests__/review.test.ts`

**CLI forms:**

```bash
omb review --with claude
omb review --with gemini
omb review --with claude --handoff latest
omb review --with claude --dry-run
```

**MVP behavior:**

- `--dry-run` prints review prompt without launching provider.
- Non-dry-run can either:
  - call an exported helper from `ask.ts`, if easy; or
  - spawn `omb ask <provider>` with the rendered prompt.
- Write review artifact under:
  - `.omb/reviews/<timestamp>-<provider>.md`
  - `.omb/reviews/index.json`

**Tests:**

- dry-run avoids external provider
- missing latest handoff gives actionable error: run `omb handoff --to <provider>` first
- unsupported provider fails clearly
- help includes `review`

---

## Phase 4 — Safe leader switch

### Task 10: Add switch contract and state

**Objective:** Model switch as handoff + launch request, not in-process hot swap.

**Files:**
- Create: `src/switch/contract.ts`
- Create: `src/switch/state.ts`
- Test: `src/switch/__tests__/state.test.ts`

**State file:**

```text
.omb/state/leader-lock.json
```

Shape:

```ts
interface LeaderSwitchState {
  active_leader?: "codebuddy" | "codex" | "claude" | "unknown";
  target_leader: "codebuddy" | "codex" | "claude";
  handoff_id: string;
  handoff_in_progress: boolean;
  created_at: string;
  old_session_id?: string;
  new_session_id?: string;
}
```

**Tests:**

- writes and reads state
- malformed state is handled with warning/friendly error

---

### Task 11: Add `omb switch --to <leader>` dry-run and status

**Objective:** Add switch UX without launching yet.

**Files:**
- Create: `src/cli/switch.ts`
- Modify: `src/cli/index.ts`
- Test: `src/cli/__tests__/switch.test.ts`

**CLI forms:**

```bash
omb switch --to claude --dry-run
omb switch status
omb switch finalize --keep-old
```

MVP dry-run should:

- validate target is `codebuddy|codex|claude`
- generate or preview handoff
- print exact launch command that would run
- not modify tmux or start provider

**Tests:**

- gemini is rejected as leader target with message that gemini can be used via review/ask
- dry-run does not launch
- status reads leader-lock/handoff-state if present

---

### Task 12: Implement `omb switch --to <leader>` launch

**Objective:** Launch a new leader with handoff context while leaving old session alive.

**Files:**
- Modify: `src/cli/switch.ts`
- Possibly export/reuse from: `src/cli/runtime/launch-pipeline.ts`
- Test: `src/cli/__tests__/switch-launch.test.ts`

**MVP launch behavior:**

1. Generate handoff artifact.
2. Write leader lock/switch state.
3. Build a prompt from `latest.md`.
4. Launch target provider through `omb exec --leader-cli <target>` or through a direct `execWithOverlay` helper if appropriate.
5. Print that old session remains alive.

Prefer non-interactive `exec` for first implementation unless interactive tmux launch is straightforward and testable. Interactive launch can be a later enhancement.

**Tests:**

- fake `codebuddy`, `codex`, `claude` binaries verify only target provider is called
- env isolation: target gets its provider home; unrelated provider homes do not leak
- old session is not killed
- failures leave handoff artifact for manual retry

---

## Phase 5 — Session-internal switch request, later enhancement

### Task 13: Add `$handoff` / `$switch` skill guidance only after CLI is stable

**Objective:** Let a provider session request switching by writing a structured request; supervisor handles actual switch outside provider process.

**Files:**
- Likely modify skill/prompt templates under `skills/` or `templates/`
- Create: `src/handoff/request.ts`
- Tests under relevant skill/template tests

**Behavior:**

- `$switch claude` in a session should produce or trigger a `.omb/state/handoff-request.json` request.
- OMB stop hook/supervisor notices request and tells user to run `omb switch --to claude` or launches if explicitly enabled.

Do not implement this before `omb handoff` + `omb switch` CLI are stable.

---

## Verification plan

### Fast targeted loop

After each phase:

```bash
npm run build
node --test dist/handoff/__tests__/*.test.js
node --test dist/cli/__tests__/handoff.test.js
```

As review/switch are added:

```bash
node --test dist/review/__tests__/*.test.js dist/cli/__tests__/review.test.js
node --test dist/switch/__tests__/*.test.js dist/cli/__tests__/switch*.test.js
```

### Full quality gate

Before reporting complete:

```bash
npm test
npm run lint
npm run catalog:check
```

### Isolated dogfood

Use temp HOME to avoid real config pollution:

```bash
WORK=/tmp/omb-handoff-dogfood.$(openssl rand -hex 3)
mkdir -p "$WORK/home" "$WORK/project"
cd "$WORK/project"
git init
printf 'hello\n' > README.md
git add README.md
git commit -m init
HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" node /home/ubuntu/Projects/oh-my-codebuddy/dist/cli/omb.js handoff --to claude --reason "dogfood"
HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" node /home/ubuntu/Projects/oh-my-codebuddy/dist/cli/omb.js handoff list
HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" node /home/ubuntu/Projects/oh-my-codebuddy/dist/cli/omb.js handoff show latest
```

If `review` is implemented, dogfood dry-run first:

```bash
HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" node /home/ubuntu/Projects/oh-my-codebuddy/dist/cli/omb.js review --with claude --dry-run
```

If `switch` is implemented, dogfood dry-run first:

```bash
HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" node /home/ubuntu/Projects/oh-my-codebuddy/dist/cli/omb.js switch --to codex --dry-run
```

---

## Autopilot execution instructions for Codex/OMX

Use `omx` because the user explicitly asked for Codex autopilot. `omb --leader-cli codex` is possible, but `omx` is the native Codex wrapper and has the direct `$autopilot` workflow.

Autopilot prompt:

```text
$autopilot Implement the provider handoff foundation in /home/ubuntu/Projects/oh-my-codebuddy following docs/plans/2026-05-05-provider-handoff-switch.md.

Constraints:
- Do not commit or push.
- Keep MVP focused: prioritize Phase 1 and Phase 2 first (`omb handoff` artifact generation and CLI). Implement review/switch only if Phase 1-2 are solid and time remains.
- No new dependencies.
- Do not modify real ~/.codebuddy, ~/.codex, or ~/.claude in tests.
- Use TDD: add tests before implementation for each new module/CLI behavior.
- Preserve existing behavior and CLI compatibility.
- Verify with npm run build and targeted node --test commands. If feasible, run npm test, npm run lint, and npm run catalog:check before stopping.
- Report changed files, exact tests run, and remaining risks.
```

---

## Definition of done for first deliverable

Minimum acceptable completed deliverable:

- `omb handoff --to <provider>` works.
- `omb handoff <provider>` works.
- `omb handoff --dry-run` does not write artifacts.
- `omb handoff list` and `omb handoff show latest` work.
- Artifacts are written under `.omb/handoffs/` and `.omb/state/handoff-state.json`.
- Tests cover contract, paths, context fallback, render, artifact writer, CLI parse/routing.
- `npm run build` and targeted tests pass.

Stretch deliverables:

- `omb review --with claude|gemini --dry-run`.
- `omb switch --to codebuddy|codex|claude --dry-run`.
- Provider capability registry refactor only if it naturally simplifies implementation; do not do a broad refactor first.
