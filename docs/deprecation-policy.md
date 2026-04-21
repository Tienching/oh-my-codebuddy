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
| `CODEBUDDY_HOME` | `CODEX_HOME` | active_compat | v2.0 | Set `CODEBUDDY_HOME` instead of `CODEX_HOME` |
| `OMB_ENTRY_PATH` | `OMX_ENTRY_PATH` | active_compat | v2.0 | Set `OMB_ENTRY_PATH` instead of `OMX_ENTRY_PATH` |
| `OMB_RUNTIME_BRIDGE` | `OMX_RUNTIME_BRIDGE` | active_compat | v2.0 | Set `OMB_RUNTIME_BRIDGE` instead of `OMX_RUNTIME_BRIDGE` |
| `OMB_RUNTIME_BINARY` | `OMX_RUNTIME_BINARY` | active_compat | v2.0 | Set `OMB_RUNTIME_BINARY` instead of `OMX_RUNTIME_BINARY` |

### Directory Names

| Canonical | Legacy | Status | Earliest Removal | Migration |
|-----------|--------|--------|-----------------|-----------|
| `~/.codebuddy` | `~/.codex` | read_only | v1.14 | Move contents to `~/.codebuddy`; symlink `~/.codex` → `~/.codebuddy` |
| `.omb` | `.omx` | active_compat | v2.0 | Run `omb setup` to migrate; `.omx` is read as fallback |

### Binary Names

| Canonical | Legacy | Status | Earliest Removal | Migration |
|-----------|--------|--------|-----------------|-----------|
| `omb` | `omx` | active_compat | v2.0 | Use `omb` command; `omx` remains as symlink |

### Setup Scope Migration

| From | To | Status | Migration |
|------|----|--------|-----------|
| `project-local` | `project` | deprecated | Re-run `omb setup` to update scope |

### Model Migration

| From | To | Status | Migration |
|------|----|--------|-----------|
| `gpt-5.3-codex` | current frontier model | active | Update config.toml or re-run `omb setup` |

## Resolution Priority

All alias pairs follow the same resolution priority:

1. **Canonical name** (e.g. `CODEBUDDY_HOME`, `OMB_ENTRY_PATH`)
2. **Legacy name** (e.g. `CODEX_HOME`, `OMX_ENTRY_PATH`)
3. **Default value** (e.g. `~/.codebuddy`, `null`)

For directory reads, canonical path is tried first; legacy path is a
read-through fallback. For writes, canonical path is always written; legacy
path is written only when alias status is `active_compat`.

## Dual-Write Gate

Legacy paths receive writes only when the corresponding alias has status
`active_compat`. This is enforced through `shouldDualWrite()` in
`src/compat/legacy-boundary.ts`. When status transitions to `read_only` or
`write_disabled`, dual-writes stop automatically.

## Deprecation Timeline

- **v0.12** (current): All aliases at `active_compat` or `read_only`
- **v1.0**: `.codex` directory transitions from `read_only` to `write_disabled`
- **v1.14**: `.codex` directory becomes `removal_candidate`; symlink creation stops
- **v2.0**: All legacy aliases removed; `omx` binary symlink removed

## CHANGELOG Deprecation Format

When a legacy alias status changes, add a deprecation entry to CHANGELOG:

```markdown
### Deprecated

- **CODEX_HOME** env var: status changed from `active_compat` to `warn_only`.
  Use `CODEBUDDY_HOME` instead. Will be removed in v2.0.
  ([alias registry](./docs/deprecation-policy.md))

### Removed

- **~/.codex** directory: no longer read as fallback.
  Migrate to `~/.codebuddy` before upgrading.
  ([alias registry](./docs/deprecation-policy.md))
```

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
