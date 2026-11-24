#!/usr/bin/env bash
# Usage: codex_review.sh <base-ref> <prompt-file> <out-file>
# Runs Codex CLI read-only from the repo root to review <base-ref>...HEAD. Retries once.
set -uo pipefail
source "$(dirname "$0")/_lib.sh"
[ $# -eq 3 ] || die "usage: codex_review.sh <base-ref> <prompt-file> <out-file>"
base="$1"; prompt_file="$2"; out="$3"
[ -f "$prompt_file" ] || die "prompt file not found: $prompt_file"
command -v codex >/dev/null || die "codex CLI not installed (npm i -g @openai/codex, then: codex login)"
root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
git -C "$root" rev-parse --verify --quiet "$base" >/dev/null || die "unknown base ref: $base"
mkdir -p "$(dirname "$out")"
model="$(cfg codex_review_model)"; [ -z "$model" ] && model="$(cfg codex_model)"
t="$(cfg codex_timeout 2400)"
args=(exec --cd "$root" --sandbox read-only --skip-git-repo-check --output-last-message "$out")
[ -n "$model" ] && args+=(-m "$model")
for attempt in 1 2; do
  if run_with_timeout "$t" codex "${args[@]}" "$(cat "$prompt_file")" </dev/null >"$out.log" 2>&1 && [ -s "$out" ]; then
    echo "OK: review saved to $out"
    grep -E 'VERDICT:' "$out" | tail -1 || echo "(no VERDICT line found — read the review)"
    exit 0
  fi
  echo "Codex review attempt $attempt failed. Last log lines:" >&2; tail -5 "$out.log" >&2
  [ "$attempt" = 1 ] && sleep 15
done
echo "FAILED: see $out.log" >&2; exit 1
