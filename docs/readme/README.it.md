# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy è un livello di orchestrazione per workflow CodeBuddy CLI.

OMB aggiunge sopra il CLI principale:
- un workflow standard: `$deep-interview` → `$ralplan` → `$team` / `$ralph`
- skill e prompt di ruolo riutilizzabili
- team runtime persistente con tmux/worktree
- parità CLI/MCP per state, memory, trace e code-intel
- guidance di progetto tramite `AGENTS.md`

**Comando principale:** `omb`

## Installazione

```bash
npm install -g oh-my-codebuddy
omb setup
```

## Avvio rapido

```bash
omb --madmax --high
```

Oppure esplicitamente in tmux:

```bash
omb --tmux --madmax --high
```

Dentro la sessione:

```text
$deep-interview "chiarisci ambito e vincoli"
$ralplan "trasformalo in un piano approvato"
$ralph "porta il piano approvato fino al completamento verificato"
$team 3:executor "esegui in parallelo il piano approvato"
```

## Comandi chiave

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

## Dati runtime

Percorso runtime principale:
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

La compatibilità con stati di progetto precedenti resta disponibile dove necessario.

## Documentazione

- [README canonico in inglese](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
