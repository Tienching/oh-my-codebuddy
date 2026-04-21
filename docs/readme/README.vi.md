# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy là lớp orchestration cho workflow CodeBuddy CLI.

OMB bổ sung lên trên CLI chính:
- flow chuẩn: `$deep-interview` → `$ralplan` → `$team` / `$ralph`
- skill và role prompt có thể tái sử dụng
- team runtime bền vững với tmux/worktree
- CLI/MCP parity cho state, memory, trace và code-intel
- hướng dẫn dự án qua `AGENTS.md`

**Lệnh chính:** `omb`

## Cài đặt

```bash
npm install -g oh-my-codebuddy
omb setup
```

## Bắt đầu nhanh

```bash
omb --madmax --high
```

Hoặc chạy rõ ràng trong tmux:

```bash
omb --tmux --madmax --high
```

Trong phiên làm việc:

```text
$deep-interview "làm rõ phạm vi và ràng buộc"
$ralplan "biến nó thành kế hoạch đã được duyệt"
$ralph "đẩy kế hoạch đã duyệt đến hoàn tất có kiểm chứng"
$team 3:executor "thực thi kế hoạch đã duyệt theo nhiều lane song song"
```

## Lệnh quan trọng

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

## Dữ liệu runtime

Đường dẫn runtime chính:
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

Tương thích với trạng thái dự án cũ vẫn được giữ ở nơi cần thiết.

## Tài liệu

- [README tiếng Anh chuẩn](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
