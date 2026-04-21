# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy é uma camada de orquestração para workflows com CodeBuddy CLI.

OMB adiciona sobre o CLI principal:
- um fluxo padrão: `$deep-interview` → `$ralplan` → `$team` / `$ralph`
- skills e prompts de papel reutilizáveis
- runtime de equipe durável com tmux/worktrees
- paridade CLI/MCP para state, memory, trace e code-intel
- orientação de projeto via `AGENTS.md`

**Comando principal:** `omb`

## Instalação

```bash
npm install -g oh-my-codebuddy
omb setup
```

## Início rápido

```bash
omb --madmax --high
```

Ou explicitamente dentro de tmux:

```bash
omb --tmux --madmax --high
```

Dentro da sessão:

```text
$deep-interview "esclareça escopo e restrições"
$ralplan "transforme isso em um plano aprovado"
$ralph "leve o plano aprovado até a conclusão verificada"
$team 3:executor "execute o plano aprovado em paralelo"
```

## Comandos principais

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

## Dados de runtime

Caminho principal de runtime:
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

A compatibilidade com estados anteriores do projeto continua onde necessário.

## Documentação

- [README canônico em inglês](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
