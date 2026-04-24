#!/usr/bin/env bash
# clean-team-env.sh — Unset all OMB_TEAM_* and OMB_TEAM_* environment variables.
#
# Usage:
#   source scripts/clean-team-env.sh    # unset in current shell
#   bash scripts/clean-team-env.sh      # print unset commands (for eval)
#
# When sourced, this script unsets the variables in the calling shell.
# When executed directly, it prints the unset commands so you can:
#   eval "$(bash scripts/clean-team-env.sh)"

set -euo pipefail

# Collect variable names to unset
vars_to_unset=()

while IFS='=' read -r name _; do
  case "$name" in
    OMB_TEAM_*|OMB_TEAM_*)
      vars_to_unset+=("$name")
      ;;
  esac
done < <(env)

if [[ "${#vars_to_unset[@]}" -eq 0 ]]; then
  if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "# No OMB_TEAM_* or OMB_TEAM_* variables found"
  fi
  exit 0
fi

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  # Executed directly — print unset commands
  for var in "${vars_to_unset[@]}"; do
    echo "unset $var"
  done
else
  # Sourced — unset directly
  for var in "${vars_to_unset[@]}"; do
    unset "$var"
  done
  echo "# Cleaned ${#vars_to_unset[@]} team env var(s): ${vars_to_unset[*]}" >&2
fi
