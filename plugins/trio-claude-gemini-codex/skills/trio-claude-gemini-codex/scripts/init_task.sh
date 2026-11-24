#!/usr/bin/env bash
# Usage: init_task.sh <short-slug>  — creates .multimodel/tasks/<date>-<slug>/ and prints its path
set -euo pipefail
source "$(dirname "$0")/_lib.sh"
raw="${1:?usage: init_task.sh <short-slug>}"
slug="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)"
[ -n "$slug" ] || die "slug is empty after cleanup; use letters/numbers"
root="$(repo_root)"; mm="$root/.multimodel"
mkdir -p "$mm/tasks"
[ -f "$mm/config.yaml" ] || { cp "$SKILL_DIR/config.example.yaml" "$mm/config.yaml"; echo "Created $mm/config.yaml — fill in test/deploy commands." >&2; }
[ -f "$mm/.gitignore" ] || printf 'worktrees/\n' > "$mm/.gitignore"
dir="$mm/tasks/$(date +%Y%m%d)-$slug"
mkdir -p "$dir/screenshots"
echo "$dir"
