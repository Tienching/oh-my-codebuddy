# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy — это слой оркестрации для workflow в CodeBuddy CLI.

OMB добавляет поверх основного CLI:
- стандартный поток: `$deep-interview` → `$ralplan` → `$team` / `$ralph`
- переиспользуемые навыки и role prompts
- устойчивый team runtime на tmux/worktrees
- CLI/MCP parity для state, memory, trace и code-intel
- проектные правила через `AGENTS.md`

**Основная команда:** `omb`

## Установка

```bash
npm install -g oh-my-codebuddy
omb setup
```

## Быстрый старт

```bash
omb --madmax --high
```

Или явно внутри tmux:

```bash
omb --tmux --madmax --high
```

Внутри сессии:

```text
$deep-interview "уточни границы и ограничения"
$ralplan "преврати это в утверждённый план"
$ralph "доведи утверждённый план до завершения с проверкой"
$team 3:executor "выполни утверждённый план параллельно"
```

## Ключевые команды

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

## Runtime-данные

Основной runtime-путь:
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

Совместимость с прежним состоянием проекта сохраняется там, где это нужно.

## Документация

- [Канонический README на английском](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
