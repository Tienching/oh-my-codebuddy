# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy to warstwa orkiestracji dla workflow CodeBuddy CLI.

OMB dodaje nad głównym CLI:
- standardowy przepływ: `$deep-interview` → `$ralplan` → `$team` / `$ralph`
- wielokrotnego użytku skille i prompty ról
- trwały team runtime oparty o tmux/worktrees
- parytet CLI/MCP dla state, memory, trace i code-intel
- guidance projektu przez `AGENTS.md`

**Główna komenda:** `omb`

## Instalacja

```bash
npm install -g oh-my-codebuddy
omb setup
```

## Szybki start

```bash
omb --madmax --high
```

Albo jawnie w tmux:

```bash
omb --tmux --madmax --high
```

W sesji:

```text
$deep-interview "doprecyzuj zakres i ograniczenia"
$ralplan "zamień to w zatwierdzony plan"
$ralph "doprowadź zatwierdzony plan do końca z weryfikacją"
$team 3:executor "wykonaj zatwierdzony plan równolegle"
```

## Kluczowe komendy

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

## Dane runtime

Główna ścieżka runtime:
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

Zgodność ze starszym stanem projektu nadal jest utrzymywana tam, gdzie to potrzebne.

## Dokumentacja

- [Kanoniczny README po angielsku](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
