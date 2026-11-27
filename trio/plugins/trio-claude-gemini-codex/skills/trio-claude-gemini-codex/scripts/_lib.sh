# Shared helpers for trio-claude-gemini-codex scripts (sourced, not run).
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "ERROR: $*" >&2; exit 1; }
repo_root() { git rev-parse --show-toplevel 2>/dev/null || pwd; }
cfg() { "$SKILL_DIR/scripts/cfg.sh" "$@"; }
valid_timeout() { [[ "$1" =~ ^[1-9][0-9]{0,5}$ ]]; }
valid_effort() { case "$1" in ""|none|minimal|low|medium|high|xhigh) return 0;; *) return 1;; esac; }
run_with_timeout() {
  local t="$1"; shift
  valid_timeout "$t" || { echo "ERROR: invalid timeout: $t" >&2; return 2; }
  python3 "$SKILL_DIR/scripts/run_timeout.py" "$t" "$@"
}
run_state() { python3 "$SKILL_DIR/scripts/run_state.py" "$@"; }
# Once a run starts, record a terminal result even if a later command fails.
# Only one writer may operate on a task/worktree or review output at a time.
lock_run() {
  run_lock="$1"
  mkdir "$run_lock" 2>/dev/null || die "run is locked: $run_lock (remove only after verifying no run is active)"
  trap 'rmdir "$run_lock" 2>/dev/null || true' EXIT
}
begin_locked_run() {
  run_artifact="$1"
  run_state "$run_artifact" running "" || die "cannot write run state"
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'rc=$?; if [ "$rc" -eq 0 ]; then state=succeeded; else state=failed; fi; run_state "$run_artifact" "$state" "$rc" || rc=1; rmdir "$run_lock" 2>/dev/null || true; exit "$rc"' EXIT
}
agy_bin() { command -v agy 2>/dev/null || { [ -x "$HOME/.local/bin/agy" ] && echo "$HOME/.local/bin/agy"; }; }

# Exact file paths only. Include nested files and literal .geminiignore entries.
find_secrets() {
  python3 "$SKILL_DIR/scripts/secret_paths.py" "$1"
}
