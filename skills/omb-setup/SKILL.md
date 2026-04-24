---
name: omb-setup
description: Setup and configure oh-my-codebuddy using current CLI behavior
---

# OMB Setup

Use this skill when users want to install or refresh oh-my-codebuddy for the **current project plus user-level OMB directories**.

## Command

```bash
omb setup [--force] [--dry-run] [--verbose] [--scope <user|project>]
```

If you only want lightweight `AGENTS.md` scaffolding for an existing repo or subtree, use `omb agents-init [path]` instead of full setup.

Supported setup flags (current implementation):
- `--force`: overwrite/reinstall managed artifacts where applicable
- `--dry-run`: print actions without mutating files
- `--verbose`: print per-file/per-step details
- `--scope`: choose install scope (`user`, `project`)

## What this setup actually does

`omb setup` performs these steps:

1. Resolve setup scope:
   - `--scope` explicit value
   - else persisted `./.omb/setup-scope.json` (with automatic migration of legacy values)
   - else interactive prompt on TTY (default `user`)
   - else default `user` (safe for CI/tests)
2. Create directories and persist effective scope
3. Install prompts, native agent configs, skills, and merge config.toml (scope determines target directories)
4. Verify Team CLI API interop markers exist in built `dist/cli/team.js`
5. Generate project-root `./AGENTS.md` from `templates/AGENTS.md` (or skip when existing and no force)
6. Configure notify hook references and write `./.omb/hud-config.json`

## Important behavior notes

- `omb setup` only prompts for scope when no scope is provided/persisted and stdin/stdout are TTY.
- Local project orchestration file is `./AGENTS.md` (project root).
- If `AGENTS.md` exists and `--force` is not used, interactive TTY runs ask whether to overwrite. Non-interactive runs preserve the file.
- Scope targets:
  - `user`: user directories (`~/.codex`, `~/.codex/skills`, `~/.omb/agents`)
  - `project`: local directories (`./.codex`, `./.codex/skills`, `./.omb/agents`)
- Migration hint: in `user` scope, if historical `~/.agents/skills` still exists alongside `${CODEX_HOME:-~/.codex}/skills`, current setup prints a cleanup hint because Codex may show duplicate skill entries until the legacy tree is removed or archived.
- If persisted scope is `project`, `omb` launch automatically uses `CODEX_HOME=./.codex` unless user explicitly overrides `CODEX_HOME`.
- With `--force`, AGENTS overwrite may still be skipped if an active OMB session is detected (safety guard).
- Legacy persisted scope values (`project-local`) are automatically migrated to `project` with a one-time warning.

## Recommended workflow

1. Run setup:

```bash
omb setup --force --verbose
```

2. Verify installation:

```bash
omb doctor
```

3. Start CodeBuddy with OMB in the target project directory (`omb` remains the compatibility alias where needed).

## Expected verification indicators

From `omb doctor`, expect:
- Prompts installed (scope-dependent: user or project)
- Skills installed (scope-dependent: user or project)
- AGENTS.md found in project root
- `.omb/state` exists
- OMB MCP servers configured in scope target `config.toml` (`~/.codex/config.toml` or `./.codex/config.toml`)

## Troubleshooting

- If using local source changes, run build first:

```bash
npm run build
```

- If your global `omb` points to another install, run local entrypoint:

```bash
node bin/omb.js setup --force --verbose
node bin/omb.js doctor
```

- If AGENTS.md was not overwritten during `--force`, stop active OMB session and rerun setup.
