# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy 是面向 CodeBuddy CLI 工作流程的編排層。

OMB 在底層編碼 CLI 之上補充：
- 標準工作流程：`$deep-interview` → `$ralplan` → `$team` / `$ralph`
- 可重用的 skills 與角色 prompts
- 基於 tmux/worktree 的持久 team runtime
- 面向 state、memory、trace、code-intel 的 CLI/MCP parity
- 透過 `AGENTS.md` 提供專案級 guidance

**主要指令：** `omb`

## 安裝

```bash
npm install -g oh-my-codebuddy
omb setup
```

## 快速開始

```bash
omb --madmax --high
```

若你明確希望在 tmux 中啟動：

```bash
omb --tmux --madmax --high
```

進入會話後可使用：

```text
$deep-interview "釐清範圍與限制"
$ralplan "把釐清結果整理成已核准的計畫"
$ralph "將已核准計畫持續推進到完成並驗證"
$team 3:executor "平行執行已核准的計畫"
```

## 關鍵指令

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

## 執行期資料

主要執行期路徑：
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

舊專案狀態的相容也仍在需要的地方保留。

## 文件

- [英文主 README](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
