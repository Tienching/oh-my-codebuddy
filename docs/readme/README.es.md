# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy es una capa de orquestación para flujos de trabajo con CodeBuddy CLI.

OMB añade sobre el CLI principal:
- un flujo estándar: `$deep-interview` → `$ralplan` → `$team` / `$ralph`
- skills y prompts de rol reutilizables
- runtime persistente de equipos con tmux/worktrees
- paridad CLI/MCP para state, memory, trace y code-intel
- guía de proyecto mediante `AGENTS.md`

**Comando principal:** `omb`

## Instalación

```bash
npm install -g oh-my-codebuddy
omb setup
```

## Inicio rápido

```bash
omb --madmax --high
```

O explícitamente dentro de tmux:

```bash
omb --tmux --madmax --high
```

Dentro de la sesión:

```text
$deep-interview "aclara alcance y restricciones"
$ralplan "convierte eso en un plan aprobado"
$ralph "lleva el plan aprobado hasta terminarlo y verificarlo"
$team 3:executor "ejecuta el plan aprobado en paralelo"
```

## Comandos clave

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

## Datos de runtime

Ruta principal de runtime:
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

La compatibilidad con estados de proyecto anteriores sigue presente donde hace falta.

## Documentación

- [README canónico en inglés](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
