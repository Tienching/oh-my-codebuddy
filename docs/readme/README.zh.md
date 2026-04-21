# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy 是面向 CodeBuddy CLI 工作流的编排层。

OMB 在底层编码 CLI 之上补充了：
- 标准工作流：`$deep-interview` → `$ralplan` → `$team` / `$ralph`
- 可复用的 skills 和角色 prompts
- 基于 tmux/worktree 的持久 team runtime
- 面向 state、memory、trace、code-intel 的 CLI/MCP parity
- 通过 `AGENTS.md` 提供项目级 guidance

**主命令：** `omb`

## 安装

```bash
npm install -g oh-my-codebuddy
omb setup
```

## 快速开始

```bash
omb --madmax --high
```

如果你明确希望在 tmux 中启动：

```bash
omb --tmux --madmax --high
```

进入会话后可使用：

```text
$deep-interview "澄清范围与约束"
$ralplan "把澄清结果整理成已批准的计划"
$ralph "将已批准计划持续推进到完成并验证"
$team 3:executor "并行执行已批准的计划"
```

## 关键命令

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

## 运行时数据

主要运行时路径：
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

旧项目状态的兼容也仍在需要的地方保留。

## 文档

- [英文主 README](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
