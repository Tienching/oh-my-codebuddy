# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy — це шар оркестрації для workflow у CodeBuddy CLI.

OMB додає поверх основного CLI:
- стандартний потік: `$deep-interview` → `$ralplan` → `$team` / `$ralph`
- багаторазові skills і role prompts
- стійкий team runtime на tmux/worktrees
- CLI/MCP parity для state, memory, trace і code-intel
- проєктні правила через `AGENTS.md`

**Основна команда:** `omb`

## Встановлення

```bash
npm install -g oh-my-codebuddy
omb setup
```

## Швидкий старт

```bash
omb --madmax --high
```

Або явно всередині tmux:

```bash
omb --tmux --madmax --high
```

Усередині сесії:

```text
$deep-interview "уточни межі та обмеження"
$ralplan "перетвори це на затверджений план"
$ralph "доведи затверджений план до завершення з перевіркою"
$team 3:executor "виконай затверджений план паралельно"
```

## Ключові команди

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

## Runtime-дані

Основний runtime-шлях:
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

Сумісність зі старішим станом проєкту також зберігається там, де це потрібно.

## Документація

- [Канонічний README англійською](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
