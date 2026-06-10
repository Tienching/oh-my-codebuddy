# Troubleshooting Guide

Common issues and recovery procedures for oh-my-codebuddy.

> ⚠️ Before any destructive operation, back up your `.omb` directory and check `git status`.

## Quick Diagnostics

| Command | Purpose |
|---------|---------|
| `omb doctor` | Check overall installation health |
| `omb doctor --team` | Check team runtime health |
| `omb team status <name>` | Show team status |
| `omb cleanup` | Kill orphaned processes and remove stale temp dirs |

## Team Issues

### Team appears stuck / not responding

**Symptoms:** `omb team status` shows workers as `unknown` or team won't shut down.

**Diagnosis:**
1. Check if tmux session exists: `tmux has-session -t omb-team-<name>`
2. Check worker heartbeats: `omb team api read-worker-heartbeat --input '{"team_name":"<name>","worker":"worker-1"}'`
3. Check for stale locks: `ls .omb/state/team/<name>/locks/`

**Recovery:**
- If tmux session is gone: `omb team api orphan-cleanup --input '{"team_name":"<name>"}'`
- If workers are stale but session exists: `omb team api cleanup --input '{"team_name":"<name>","force":true}'`
- Manual cleanup (last resort): `rm -rf .omb/state/team/<name>/`

### Corrupt team state

**Symptoms:** `omb team status` returns unexpected errors or missing data.

**Diagnosis:**
1. Check corruption log: `cat .omb/state/corruption-log.jsonl`
2. Verify team config exists: `cat .omb/state/team/<name>/config.json`

**Recovery:**
- For corrupt config: Back up and delete `config.json`, then re-create the team
- For corrupt task files: Check `corruption-log.jsonl` for affected file paths
- Manual cleanup: `rm .omb/state/team/<name>/tasks/<task-id>.json` (only if confirmed corrupt)

## Worktree Issues

### worktree_dirty: Worktree has uncommitted changes

**Symptoms:** `omb team start` or worktree operations fail with `worktree_dirty`.

**Recovery:**
1. Enter the worktree directory
2. Check status: `git status`
3. Commit or stash changes: `git stash` or `git add . && git commit -m "wip"`
4. Retry the operation

### worktree_owner_mismatch: Worktree belongs to a different team/worker

**Symptoms:** Error message indicates owner metadata doesn't match current context.

**Recovery:**
1. Check owner metadata: `cat <worktree-path>/.omb-worktree-owner.json`
2. If the worktree is from an old session: `omb doctor --worktrees`
3. Manual cleanup: `git worktree remove <worktree-path>`

### worktree_not_git: Directory exists but is not a git worktree

**Symptoms:** A non-git directory or file exists at the expected worktree path.

**Recovery:**
1. Check what's at the path: `ls -la <path>`
2. If it's a stale directory: `rm -rf <path>`
3. If it contains important data: Back up first, then remove
4. Retry the operation

### worktree_stale_entry: Git worktree entry points to missing directory

**Symptoms:** `git worktree list` shows an entry but the directory doesn't exist.

**Recovery:**
1. Prune stale entries: `git worktree prune`
2. Or use OMB cleanup: `omb doctor --worktrees`

### worktree_branch_in_use: Branch already checked out in another worktree

**Recovery:**
1. Check where the branch is checked out: `git worktree list`
2. Either remove the other worktree or use a different branch name
3. For OMB team worktrees, the branch format is `<branch-name>/<worker-name>`

## State Lock Issues

### Stale lock files

**Symptoms:** Operations fail with lock errors even when no other OMB process is running.

**Diagnosis:**
1. Check for running OMB processes: `ps aux | grep omb`
2. List lock files: `ls .omb/state/team/<name>/locks/`

**Recovery:**
- If no OMB process is running: `rm .omb/state/team/<name>/locks/*.lock`
- ⚠️ Only remove lock files when you're certain no other process needs them

## Log Issues

### Oversized log files

**Symptoms:** `.omb/state/` directory is very large.

**Diagnosis:**
1. Check sizes: `du -sh .omb/state/team/<name>/events/`
2. Check corruption log: `wc -l .omb/state/corruption-log.jsonl`

**Recovery:**
- Event logs auto-rotate when they exceed 10MB (every 100th write)
- Delivery logs are sharded by day
- Manual cleanup of old logs: `rm .omb/logs/team-delivery-2025-*.jsonl`

## Lease Issues

### Task claim never expires

**Symptoms:** Task appears permanently claimed by a worker that's no longer running.

**Diagnosis:**
1. Check task claim: `omb team api read-task --input '{"team_name":"<name>","task_id":"1"}'`
2. Check if `leased_until` is a valid date

**Recovery:**
- Invalid lease dates are now auto-expired (treated as expired)
- Wait for the 15-minute lease TTL to expire, then: `omb team api release-task-claim --input '...'`

## Error Code Reference

| Error Code | Category | Recovery |
|-----------|----------|----------|
| `worktree_dirty` | Worktree | Commit/stash changes |
| `worktree_owner_mismatch` | Worktree | Check owner metadata, use doctor |
| `worktree_not_git` | Worktree | Remove non-git directory |
| `worktree_stale_entry` | Worktree | Run `git worktree prune` |
| `worktree_branch_in_use` | Worktree | Use different branch or remove other worktree |
| `worktree_path_conflict` | Worktree | Remove conflicting directory |
| `worktree_target_mismatch` | Worktree | Verify branch/HEAD matches expected |
| `claim_corrupt` | Task | Auto-reclaimed; check corruption log |
| `lease_corrupt_reclaimed` | Task | Auto-recovered; no action needed |

---

Also see [Troubleshooting execution readiness](#) for install-vs-execution issues, auth errors, proxy mismatches, and tmux key handling.
