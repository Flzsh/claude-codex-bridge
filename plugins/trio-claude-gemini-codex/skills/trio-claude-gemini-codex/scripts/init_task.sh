#!/usr/bin/env bash
# Usage: init_task.sh <short-slug>  — creates .multimodel/tasks/<date>-<slug>-<id>/ and prints its path
set -euo pipefail
source "$(dirname "$0")/_lib.sh"
raw="${1:?usage: init_task.sh <short-slug>}"
slug="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)"
[ -n "$slug" ] || die "slug is empty after cleanup; use letters/numbers"
root="$(repo_root)"; mm="$root/.multimodel"
mkdir -p "$mm/tasks"
if [ ! -f "$mm/config.yaml" ]; then
  config="$(mktemp "$mm/config.XXXXXXXX")"
  trap 'rm -f "$config"' EXIT
  cp "$SKILL_DIR/config.example.yaml" "$config"
  if ln "$config" "$mm/config.yaml" 2>/dev/null; then
    echo "Created $mm/config.yaml — fill in test/deploy commands." >&2
  elif [ ! -f "$mm/config.yaml" ]; then
    die "could not initialize $mm/config.yaml"
  fi
  rm -f "$config"
  trap - EXIT
fi
[ -f "$mm/.gitignore" ] || (set -C; printf 'worktrees/\n' > "$mm/.gitignore") 2>/dev/null || [ -f "$mm/.gitignore" ]
# A rule inside tasks/ keeps older .multimodel/.gitignore files and their custom rules intact.
if [ ! -f "$mm/tasks/.gitignore" ]; then
  (set -C; printf '*\n' > "$mm/tasks/.gitignore") 2>/dev/null || [ -f "$mm/tasks/.gitignore" ]
fi
dir="$(mktemp -d "$mm/tasks/$(date +%Y%m%d)-$slug-XXXXXXXX")"
mkdir "$dir/screenshots"
echo "$dir"
