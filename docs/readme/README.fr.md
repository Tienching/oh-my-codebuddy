# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy est une couche d’orchestration pour les workflows CodeBuddy CLI.

OMB ajoute au CLI principal :
- un workflow standard : `$deep-interview` → `$ralplan` → `$team` / `$ralph`
- des skills et prompts de rôle réutilisables
- un runtime d’équipe durable avec tmux/worktrees
- une parité CLI/MCP pour state, memory, trace et code-intel
- une guidance projet via `AGENTS.md`

**Commande principale :** `omb`

## Installation

```bash
npm install -g oh-my-codebuddy
omb setup
```

## Démarrage rapide

```bash
omb --madmax --high
```

Ou explicitement dans tmux :

```bash
omb --tmux --madmax --high
```

Dans la session :

```text
$deep-interview "clarifie le périmètre et les contraintes"
$ralplan "transforme cela en plan approuvé"
$ralph "mène le plan approuvé jusqu’à la fin avec vérification"
$team 3:executor "exécute le plan approuvé en parallèle"
```

## Commandes clés

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

## Données d’exécution

Chemin runtime principal :
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

La compatibilité avec les anciens états du projet reste présente quand nécessaire.

## Documentation

- [README canonique en anglais](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
