# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy ist eine Orchestrierungsschicht für CodeBuddy-CLI-Workflows.

OMB ergänzt die eigentliche Coding-CLI um:
- einen Standardablauf: `$deep-interview` → `$ralplan` → `$team` / `$ralph`
- wiederverwendbare Skills und Rollen-Prompts
- einen dauerhaften Team-Runtime auf Basis von tmux/worktrees
- CLI/MCP-Parität für State, Memory, Trace und Code-Intel
- Projekt-Guidance über `AGENTS.md`

**Primärer Befehl:** `omb`

## Installation

```bash
npm install -g oh-my-codebuddy
omb setup
```

## Schneller Start

```bash
omb --madmax --high
```

Oder explizit in tmux:

```bash
omb --tmux --madmax --high
```

Im laufenden Gespräch:

```text
$deep-interview "kläre Scope und Randbedingungen"
$ralplan "forme daraus einen freigegebenen Umsetzungsplan"
$ralph "führe den freigegebenen Plan bis zum verifizierten Abschluss aus"
$team 3:executor "setze den freigegebenen Plan parallel um"
```

## Wichtige Befehle

```bash
omb team 3:executor "fix the failing tests with verification"
omb team status <team-name>
omb team resume <team-name>
omb team shutdown <team-name>
omb explore --prompt "find where team state is written"
omb sparkshell git status
omb doctor
omb uninstall
```

## Laufzeitdaten

Primärer Laufzeitpfad:
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

Ältere Projektzustände bleiben dort kompatibel, wo sie noch gebraucht werden.

## Dokumentation

- [Kanonisches englisches README](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
