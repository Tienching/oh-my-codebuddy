# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

oh-my-codebuddy is a multi-agent orchestration layer for CodeBuddy CLI workflows.

It keeps the underlying coding agent as the execution engine, then adds:
- a guided workflow layer (`$deep-interview` → `$ralplan` → `$team` / `$ralph`)
- reusable skills and role prompts
- durable team runtime with tmux/worktree orchestration
- MCP/CLI parity for state, memory, trace, and code-intel surfaces
- repository guidance scaffolding through `AGENTS.md`

**Primary command:** `omb`

**Website:** https://tienching.github.io/oh-my-codebuddy/
**Docs:** [Getting Started](./docs/getting-started.html) · [Agents](./docs/agents.html) · [Skills](./docs/skills.html) · [Integrations](./docs/integrations.html) · [OpenClaw guide](./docs/openclaw-integration.md) · [Demo](./DEMO.md)

---

## What this project actually does

OMB is not a replacement model runner.
It is the orchestration/runtime layer around your coding CLI workflow.

In practice, OMB gives you:

- **A default workflow**
  - `$deep-interview` for clarification
  - `$ralplan` for plan approval and tradeoff review
  - `$ralph` for persistent single-owner completion loops
  - `$team` for coordinated parallel execution
- **A durable team runtime**
  - `omb team ...`
  - `omb team status`
  - `omb team resume`
  - `omb team shutdown`
- **Read-only repo exploration and shell helpers**
  - `omb explore --prompt "..."`
  - `omb sparkshell ...`
- **Install / repair / support surfaces**
  - `omb setup`
  - `omb doctor`
  - `omb uninstall`
  - `omb hud`
- **Stateful project runtime**
  - primary runtime/state under `.omb/`
  - compatibility for older project state is still preserved where needed

---

## Recommended environment

OMB is primarily designed for:
- macOS or Linux
- Node.js 20+
- tmux available
- a compatible coding CLI already installed and authenticated

Native Windows is supported less aggressively than the macOS/Linux path.
If you want team mode on Windows, WSL2 is usually the safer option.

---

## Install

### 1. Install your coding CLI

Make sure your preferred coding CLI is already installed and authenticated before using OMB.

### 2. Install OMB

```bash
npm install -g oh-my-codebuddy
```

### 3. Run setup

```bash
omb setup
```

Setup installs and refreshes:
- prompts
- skills
- native agent configs
- scoped `AGENTS.md`
- config and managed hooks
- HUD / notification wiring

### 4. Smoke-test the install

Do not stop at setup alone. Verify the runtime surfaces you actually plan to use:

```bash
omb doctor
omb --help
omb team --help
omb explore --prompt "find where team state is written"
```

If you plan to use team mode, also verify tmux is available:

```bash
tmux -V
```

---

## Fast start

Start an interactive session:

```bash
omb --madmax --high
```

If you explicitly want the leader session inside tmux:

```bash
omb --tmux --madmax --high
```

Then use the canonical workflow inside the session:

```text
$deep-interview "clarify the task and constraints"
$ralplan "turn the clarified request into an approved plan"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

### Rule of thumb

- use **`$deep-interview`** when requirements are unclear
- use **`$ralplan`** before non-trivial implementation
- use **`$ralph`** when one owner should keep pushing until verified completion
- use **`$team`** when the work benefits from parallel lanes

---

## Core commands

### Session / runtime

```bash
omb
omb --tmux
omb resume
omb doctor
omb cleanup
omb version
```

### Team runtime

```bash
omb team 3:executor "fix the failing tests with verification"
omb team status <team-name>
omb team resume <team-name>
omb team shutdown <team-name>
omb team api --help
```

### Exploration / shell helpers

```bash
omb explore --prompt "find where team state is written"
omb sparkshell git status
omb sparkshell --tmux-pane %12 --tail-lines 400
```

### Setup / uninstall

```bash
omb setup
omb uninstall
```

### Other surfaces

```bash
omb ask --help
omb autoresearch --help
omb agents --help
omb agents-init .
omb state --help
omb hooks --help
omb tmux-hook --help
omb hud --help
```

---

## Repository layout and runtime data

### Tracked project assets

OMB ships and maintains project assets such as:
- `skills/`
- `prompts/`
- `templates/`
- `agents/`
- `.codex/` project skill/prompt/agent content where applicable

### Runtime / state assets

Primary runtime state lives under:
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

Compatibility support for older project state is still present in parts of the runtime, but the current primary path is `.omb/`.

---

## Platform notes

### tmux install

| Platform | Install |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows (native) | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

### Why tmux matters

The durable team runtime depends on tmux-style pane/session orchestration for the best experience.
That is why macOS/Linux remains the recommended default.

---

## Typical workflow

1. `omb setup`
2. launch `omb --madmax --high`
3. clarify with `$deep-interview`
4. approve with `$ralplan`
5. execute with `$ralph` or `$team`
6. inspect/monitor with `omb team status`, `omb hud`, `omb doctor`, `omb trace`, or MCP parity surfaces as needed

---

## Documentation

- [Getting Started](./docs/getting-started.html)
- [Demo guide](./DEMO.md)
- [Agent catalog](./docs/agents.html)
- [Skills reference](./docs/skills.html)
- [Integrations](./docs/integrations.html)
- [Troubleshooting](./docs/troubleshooting.md)
- [State model](./docs/STATE_MODEL.md)
- [Explicit terminal stop model](./docs/contracts/explicit-terminal-stop-model.md)
- [Multi-state transition contract](./docs/contracts/multi-state-transition-contract.md)
- [CodeBuddy native hook mapping](./docs/codex-native-hooks.md)
- [OpenClaw / notification gateway guide](./docs/openclaw-integration.md)
- [Contributing](./CONTRIBUTING.md)
- [Changelog](./CHANGELOG.md)

---

## Languages

- [English](./README.md)
- [한국어](./docs/readme/README.ko.md)
- [日本語](./docs/readme/README.ja.md)
- [简体中文](./docs/readme/README.zh.md)
- [繁體中文](./docs/readme/README.zh-TW.md)
- [Tiếng Việt](./docs/readme/README.vi.md)
- [Español](./docs/readme/README.es.md)
- [Português](./docs/readme/README.pt.md)
- [Русский](./docs/readme/README.ru.md)
- [Türkçe](./docs/readme/README.tr.md)
- [Deutsch](./docs/readme/README.de.md)
- [Français](./docs/readme/README.fr.md)
- [Italiano](./docs/readme/README.it.md)
- [Ελληνικά](./docs/readme/README.el.md)
- [Polski](./docs/readme/README.pl.md)
- [Українська](./docs/readme/README.uk.md)

---

## Community

- Discord: https://discord.gg/PUwSMR9XNk
- npm: https://www.npmjs.com/package/oh-my-codebuddy
- GitHub issues: https://github.com/Tienching/oh-my-codebuddy/issues
