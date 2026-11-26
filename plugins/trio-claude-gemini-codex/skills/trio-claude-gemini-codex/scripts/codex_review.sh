#!/usr/bin/env bash
# Usage: codex_review.sh <base-ref> <prompt-file> <out-file>
set -uo pipefail
source "$(dirname "$0")/_lib.sh"
[ $# -eq 3 ] || die "usage: codex_review.sh <base-ref> <prompt-file> <out-file>"
base="$1"; prompt_file="$2"; out="$3"
[ -f "$prompt_file" ] || die "prompt file not found: $prompt_file"
command -v codex >/dev/null || die "codex CLI not installed"
root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
base_sha="$(git -C "$root" rev-parse --verify --quiet --end-of-options "$base^{commit}")" || die "unknown base commit: $base"
head_sha="$(git -C "$root" rev-parse --verify HEAD)" || die "unknown HEAD"
git -C "$root" merge-base "$base_sha" "$head_sha" >/dev/null || die "base and HEAD have no common ancestor"
mkdir -p "$(dirname "$out")" || die "cannot create output directory"
out="$(cd "$(dirname "$out")" && pwd -P)/$(basename "$out")"
model="$(cfg codex_review_model)" || die "cannot read config"; [ -n "$model" ] || { model="$(cfg codex_model)" || die "cannot read config"; }
effort="$(cfg codex_review_reasoning_effort)" || die "cannot read config"; [ -n "$effort" ] || { effort="$(cfg codex_reasoning_effort)" || die "cannot read config"; }
t="$(cfg codex_timeout 2400)" || die "cannot read config"
valid_effort "$effort" || die "invalid Codex review reasoning effort: $effort"
valid_timeout "$t" || die "invalid codex_timeout: $t"
lock_run "$out.lock"
begin_locked_run "$out"
attempt_dir="$(mktemp -d "$(dirname "$out")/.codex-review.XXXXXX")" || die "cannot create review attempt directory"
{
  printf 'Review exactly these commits: git diff %s...%s and git log %s..%s. Use these pinned commits if the following prompt names a different ref.\n\n' "$base_sha" "$head_sha" "$base_sha" "$head_sha"
  cat "$prompt_file"
} >"$attempt_dir/prompt.md" || die "cannot prepare review prompt"
for old in "$out" "$out.log"; do
  [ ! -e "$old" ] || mv "$old" "$attempt_dir/previous-$(basename "$old")" || die "cannot archive previous review"
done
args=(exec --cd "$root" --sandbox read-only)
[ -z "$model" ] || args+=(-m "$model")
[ -z "$effort" ] || args+=(-c "model_reasoning_effort=\"$effort\"")
for attempt in 1 2; do
  result="$attempt_dir/review-$attempt.md"
  log="$attempt_dir/attempt-$attempt.log"
  if run_with_timeout "$t" codex "${args[@]}" --output-last-message "$result" - <"$attempt_dir/prompt.md" >"$log" 2>&1 && [ -s "$result" ]; then
    verdict="$(awk 'NF {last=$0} END {sub(/\r$/, "", last); print last}' "$result")"
    case "$verdict" in
      "VERDICT: APPROVE"|"VERDICT: CHANGES_REQUESTED")
        [ "$(git -C "$root" rev-parse HEAD)" = "$head_sha" ] || die "HEAD changed during review; rerun for new HEAD"
        cp "$log" "$out.log" && cp "$result" "$out" || die "cannot publish review"
        echo "OK: review saved to $out"
        echo "$verdict"
        exit 0;;
    esac
  fi
  cp "$log" "$out.log" || die "cannot save review log"
  echo "Codex review attempt $attempt failed or returned an invalid verdict. See $log" >&2
  [ "$attempt" = 2 ] || sleep 15
done
die "review failed: $attempt_dir"
