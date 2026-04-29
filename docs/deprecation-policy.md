# Legacy Alias Deprecation Policy

This document tracks all legacy name aliases in oh-my-codebuddy, their current
status, earliest removal version, and migration path.

## Status Definitions

| Status | Meaning |
|--------|---------|
| `active_compat` | Both names work; dual-write where applicable; canonical reads first |
| `warn_only` | Legacy name recognised but emits a deprecation warning |
| `read_only` | Legacy path is read but never written |
| `write_disabled` | Legacy path is never written; read-through only |
| `removal_candidate` | Legacy path ignored; safe to delete all references |

## Alias Registry

### Environment Variables

| Canonical | Legacy | Status | Earliest Removal | Migration |
|-----------|--------|--------|-----------------|-----------|
| `CODEBUDDY_HOME` | `CODEX_HOME` | removal_candidate | v0.13 | Set `CODEBUDDY_HOME`; `CODEX_HOME` is only for Codex provider homes |
| `OMB_ENTRY_PATH` | `OMB_ENTRY_PATH` | active_compat | v2.0 | Set `OMB_ENTRY_PATH` instead of `OMB_ENTRY_PATH` |
| `OMB_RUNTIME_BRIDGE` | `OMB_RUNTIME_BRIDGE` | active_compat | v2.0 | Set `OMB_RUNTIME_BRIDGE` instead of `OMB_RUNTIME_BRIDGE` |
| `OMB_RUNTIME_BINARY` | `OMB_RUNTIME_BINARY` | active_compat | v2.0 | Set `OMB_RUNTIME_BINARY` instead of `OMB_RUNTIME_BINARY` |

### Directory Names

| Canonical | Legacy | Status | Earliest Removal | Migration |
|-----------|--------|--------|-----------------|-----------|
| `~/.codebuddy` | `~/.codex` | read_only | v1.14 | Move contents to `~/.codebuddy`; symlink `~/.codex` → `~/.codebuddy` |
| `.omb` | `.omb` | active_compat | v2.0 | Run `omb setup` to migrate; `.omb` is read as fallback |

### Binary Names

| Canonical | Legacy | Status | Earliest Removal | Migration |
|-----------|--------|--------|-----------------|-----------|
| `omb` | `omb` | active_compat | v2.0 | Use `omb` command; `omb` remains as symlink |

### Setup Scope Migration

| From | To | Status | Migration |
|------|----|--------|-----------|
| `project-local` | `project` | deprecated | Re-run `omb setup` to update scope |

### Configuration Files

| Canonical | Legacy | Status | Earliest Removal | Migration |
|-----------|--------|--------|-----------------|-----------|
| `~/.codebuddy/.omb-config.json` providers block | `~/.codebuddy/config.toml` `model_provider` + `[model_providers.*]` | read_only | v0.14 | Re-run `omb setup --provider codebuddy`. Setup migrates OMB-consumed fields into `.omb-config.json` and deletes the legacy codex-format TOML. `readActiveProviderEnvOverrides` still falls back to the TOML for upgrade-but-not-yet-resetup users until v0.14. |

### Model Migration

| From | To | Status | Migration |
|------|----|--------|-----------|
| `gpt-5.3-codex` | current frontier model | active | Update config.toml or re-run `omb setup` |

## Resolution Priority

CodeBuddy and Codex provider homes no longer cross-fallback to each other:

- CodeBuddy home: `CODEBUDDY_HOME` → `~/.codebuddy`
- Codex home: `CODEX_HOME` → `~/.codex`

Other remaining alias pairs that are still marked `active_compat` follow the
same resolution priority:

1. **Canonical name** (for example `OMB_ENTRY_PATH`)
2. **Legacy name** (for example an older `OMB_*` alias)
3. **Default value** (for example `null`)

For directory reads, canonical path is tried first only for alias pairs that
remain active. Legacy paths are not read as fallbacks once their alias status is
`removal_candidate`. For writes, canonical path is always written; legacy path
is written only when alias status is `active_compat`.

## Dual-Write Gate

Legacy paths receive writes only when the corresponding alias has status
`active_compat`. This is enforced through `shouldDualWrite()` in
`src/compat/legacy-boundary.ts`. When status transitions to `read_only` or
`write_disabled`, dual-writes stop automatically.

## Deprecation Timeline

- **v0.12** (current): CodeBuddy no longer reads `CODEX_HOME` as a home fallback; remaining aliases are `active_compat`, `read_only`, or `removal_candidate`
- **v1.0**: `.codex` directory transitions from `read_only` to `write_disabled`
- **v1.14**: `.codex` directory becomes `removal_candidate`; symlink creation stops
- **v2.0**: All legacy aliases removed; `omb` binary symlink removed

## CHANGELOG Deprecation Format

When a legacy alias status changes, add a deprecation entry to CHANGELOG:

```markdown
### Deprecated

- **OMB_LEGACY_EXAMPLE** env var: status changed from `active_compat` to `warn_only`.
  Use `OMB_CANONICAL_EXAMPLE` instead. Will be removed in v2.0.
  ([alias registry](./docs/deprecation-policy.md))

### Removed

- **~/.legacy-example** directory: no longer read as fallback.
  Migrate to `~/.canonical-example` before upgrading.
  ([alias registry](./docs/deprecation-policy.md))
```

> Example uses placeholder names so the format doesn't drift as individual
> aliases in the live matrix change status. For the current per-alias status,
> see the matrix at the top of this file.

### Entry Guidelines

1. Every deprecation entry must reference the alias name and its new status.
2. Include the recommended migration action.
3. Reference this policy document for the full timeline.
4. Removal entries are only added when code references are actually deleted.

## Diagnostic Access

The full alias registry is available at runtime through:

- `getAliasRegistry()` — returns all alias entries with status
- `findAlias(name)` — look up by canonical or legacy name
- `readLegacyAliasIfPresent(cwd)` — check which legacy dirs exist
- `omb doctor` — CLI diagnostic that reports legacy path usage
