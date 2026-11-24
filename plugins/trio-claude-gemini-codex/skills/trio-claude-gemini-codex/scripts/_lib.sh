# Shared helpers for trio-claude-gemini-codex scripts (sourced, not run).
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "ERROR: $*" >&2; exit 1; }
repo_root() { git rev-parse --show-toplevel 2>/dev/null || pwd; }
cfg() { "$SKILL_DIR/scripts/cfg.sh" "$@"; }
# macOS has no `timeout`; perl's alarm survives exec and kills the child when time is up.
run_with_timeout() { local t="$1"; shift; perl -e 'alarm shift; exec @ARGV or die "exec failed: $!\n"' "$t" "$@"; }

# Antigravity CLI (agy) replaced Gemini CLI for Free/Pro/Ultra accounts in June 2026.
agy_bin() { command -v agy 2>/dev/null || { [ -x "$HOME/.local/bin/agy" ] && echo "$HOME/.local/bin/agy"; }; }

# Secret-looking files (relative paths), used to block Gemini from reading them.
find_secrets() {
  local root="$1"
  (cd "$root" && find . -maxdepth 5 \( -name node_modules -o -name .git -o -name .multimodel -o -name .venv -o -name venv \) -prune -o -type f \
    \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name 'id_rsa*' -o -name 'id_ed25519*' \
       -o -name 'credentials*.json' -o -name 'service-account*.json' -o -name '.npmrc' -o -name '.pypirc' -o -name '.netrc' \) -print 2>/dev/null) \
    | grep -v -E '\.env\.(example|sample|template)$' | sed 's|^\./||'
}
