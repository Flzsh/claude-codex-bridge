#!/usr/bin/env bash
# Usage: init_task.sh <short-slug> | init_task.sh --resume <task-id>
set -euo pipefail
source "$(dirname "$0")/_lib.sh"
root="$(repo_root)"; mm="$root/.multimodel"
if [ "${1-}" = --resume ]; then
  [ $# -eq 2 ] || die "usage: init_task.sh --resume <task-id>"
  [[ "$2" =~ ^[0-9]{8}-[a-z0-9-]+$ ]] || die "invalid task ID"
  [ -d "$mm/tasks/$2" ] && [ ! -L "$mm/tasks/$2" ] || die "task not found: $2"
  printf '%s\n' "$mm/tasks/$2"
  exit 0
fi
[ $# -eq 1 ] || die "usage: init_task.sh <short-slug>"
slug="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)"
[ -n "$slug" ] || die "slug is empty after cleanup; use letters/numbers"
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
[ -f "$mm/tasks/.gitignore" ] || (set -C; printf '*\n' > "$mm/tasks/.gitignore") 2>/dev/null || [ -f "$mm/tasks/.gitignore" ]
base="$mm/tasks/$(date +%Y%m%d)-$slug"
dir="$base"; n=1
while ! mkdir "$dir" 2>/dev/null; do
  [ -d "$dir" ] || die "cannot create task directory: $dir"
  n=$((n + 1)); dir="$base-$n"
done
mkdir "$dir/screenshots"
printf '%s\n' "$dir"
