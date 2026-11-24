#!/usr/bin/env bash
# Usage: cfg.sh <key> [default]  — prints one value from <repo>/.multimodel/config.yaml
key="${1:?usage: cfg.sh <key> [default]}"; def="${2-}"
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
f="$root/.multimodel/config.yaml"; val=""
if [ -f "$f" ]; then
  val="$(grep -E "^[[:space:]]*${key}:" "$f" | head -1 \
    | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]+#.*$//; s/^#.*$//; s/[[:space:]]+$//' \
    | sed -E "s/^[\"'](.*)[\"']\$/\\1/")"
fi
printf '%s\n' "${val:-$def}"
