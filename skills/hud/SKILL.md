---
name: "hud"
description: "Show or configure the OMB HUD (two-layer statusline)"
role: "display"
scope: ".omb/**"
---

# HUD Skill

The OMB HUD uses a two-layer architecture:

1. **Layer 1 - Codex built-in statusLine**: Real-time TUI footer showing model, git branch, and context usage. Configured via `[tui] status_line` in `~/.codex/config.toml`. Zero code required.

2. **Layer 2 - `omb hud` CLI command**: Shows OMB-specific orchestration state (ralph, ultrawork, autopilot, team, pipeline, ecomode, turns). Reads `.omb/state/` files.

## Quick Commands

| Command | Description |
|---------|-------------|
| `omb hud` | Show current HUD (modes, turns, activity) |
| `omb hud --watch` | Live-updating display (polls every 1s) |
| `omb hud --json` | Raw state output for scripting |
| `omb hud --preset=minimal` | Minimal display |
| `omb hud --preset=focused` | Default display |
| `omb hud --preset=full` | All elements |

## Presets

### minimal
```
[OMB] ralph:3/10 | turns:42
```

### focused (default)
```
[OMB] ralph:3/10 | ultrawork | team:3 workers | turns:42 | last:5s ago
```

### full
```
[OMB] ralph:3/10 | ultrawork | autopilot:execution | team:3 workers | pipeline:exec | turns:42 | last:5s ago | total-turns:156
```

## Setup

`omb setup` automatically configures both layers:
- Adds `[tui] status_line` to `~/.codex/config.toml` (Layer 1)
- Writes `.omb/hud-config.json` with default preset (Layer 2)
- Default preset is `focused`; if HUD/statusline changes do not appear, restart CodeBuddy CLI once.

## Layer 1: Codex Built-in StatusLine

Configured in `~/.codex/config.toml`:
```toml
[tui]
status_line = ["model-with-reasoning", "git-branch", "context-remaining"]
```

Available built-in items (CodeBuddy CLI v0.101.0+):
`model-name`, `model-with-reasoning`, `current-dir`, `project-root`, `git-branch`, `context-remaining`, `context-used`, `five-hour-limit`, `weekly-limit`, `codex-version`, `context-window-size`, `used-tokens`, `total-input-tokens`, `total-output-tokens`, `session-id`

## Layer 2: OMB Orchestration HUD

The `omb hud` command reads these state files:
- `.omb/state/ralph-state.json` - Ralph loop iteration
- `.omb/state/ultrawork-state.json` - Ultrawork mode
- `.omb/state/autopilot-state.json` - Autopilot phase
- `.omb/state/team-state.json` - Team workers
- `.omb/state/pipeline-state.json` - Pipeline stage
- `.omb/state/ecomode-state.json` - Ecomode active
- `.omb/state/hud-state.json` - Last activity (from notify hook)
- `.omb/metrics.json` - Turn counts

## Configuration

HUD config stored at `.omb/hud-config.json`:
```json
{
  "preset": "focused"
}
```

## Color Coding

- **Green**: Normal/healthy
- **Yellow**: Warning (ralph >70% of max)
- **Red**: Critical (ralph >90% of max)

## Troubleshooting

If the TUI statusline is not showing:
1. Ensure CodeBuddy CLI v0.101.0+ is installed
2. Run `omb setup` to configure `[tui]` section
3. Restart CodeBuddy CLI

If `omb hud` shows "No active modes":
- This is expected when no workflows are running
- Start a workflow (ralph, autopilot, etc.) and check again
