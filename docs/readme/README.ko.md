# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy는 CodeBuddy CLI 워크플로를 위한 오케스트레이션 레이어입니다.

OMB는 기본 CLI 위에 다음을 더합니다.
- 표준 워크플로: `$deep-interview` → `$ralplan` → `$team` / `$ralph`
- 재사용 가능한 스킬과 역할 프롬프트
- tmux/worktree 기반의 내구성 있는 팀 런타임
- state, memory, trace, code-intel용 CLI/MCP 패리티
- `AGENTS.md` 기반 프로젝트 가이드

**기본 명령:** `omb`

## 설치

```bash
npm install -g oh-my-codebuddy
omb setup
```

## 빠른 시작

```bash
omb --madmax --high
```

tmux 안에서 명시적으로 시작하려면:

```bash
omb --tmux --madmax --high
```

세션 안에서는:

```text
$deep-interview "범위와 제약을 명확히 하라"
$ralplan "그 내용을 승인 가능한 계획으로 정리하라"
$ralph "승인된 계획을 검증까지 포함해 끝까지 수행하라"
$team 3:executor "승인된 계획을 병렬로 실행하라"
```

## 주요 명령

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

## 런타임 데이터

기본 런타임 경로:
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

이전 프로젝트 상태와의 호환성도 필요한 범위에서 유지됩니다.

## 문서

- [영문 README](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
