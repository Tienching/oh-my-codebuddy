# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy は CodeBuddy CLI ワークフロー向けのオーケストレーションレイヤーです。

OMB は CLI 本体の上に次を追加します。
- 標準ワークフロー: `$deep-interview` → `$ralplan` → `$team` / `$ralph`
- 再利用可能なスキルとロールプロンプト
- tmux/worktree ベースの永続的な team runtime
- state / memory / trace / code-intel 向けの CLI/MCP parity
- `AGENTS.md` によるプロジェクトガイダンス

**主コマンド:** `omb`

## インストール

```bash
npm install -g oh-my-codebuddy
omb setup
```

## クイックスタート

```bash
omb --madmax --high
```

tmux 内で明示的に開始する場合:

```bash
omb --tmux --madmax --high
```

セッション内では:

```text
$deep-interview "スコープと制約を明確化する"
$ralplan "明確化した内容を承認済みプランにする"
$ralph "承認済みプランを検証付きで完了まで進める"
$team 3:executor "承認済みプランを並列実行する"
```

## 主なコマンド

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

## ランタイムデータ

主なランタイムパス:
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

旧プロジェクト状態との互換性も必要な箇所で維持されています。

## ドキュメント

- [英語版 README](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
