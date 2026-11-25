#!/usr/bin/env bash
# Usage: ask_gemini.sh [--isolated] <prompt-file> <out-file>
# Sends a prompt to Gemini through the Antigravity CLI (agy), headless and read-only (plan mode),
# from the repo root, pinned to a Gemini model. Retries once. Writes the answer to <out-file>
# and run details (time, tokens, denied tool calls) to <out-file>.meta.json.
# Attach images or files by writing @relative/path in a normal repo-aware prompt.
# Use --isolated for prompts that carry all context inline and need no file access.
set -uo pipefail
source "$(dirname "$0")/_lib.sh"
isolated=false
if [ "${1-}" = --isolated ]; then
  isolated=true
  shift
fi
[ $# -eq 2 ] || die "usage: ask_gemini.sh [--isolated] <prompt-file> <out-file>"
[ -f "$1" ] || die "prompt file not found: $1"
prompt_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
mkdir -p "$(dirname "$2")" || die "could not create output directory"
out="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
AGY="$(agy_bin)" || true
[ -n "$AGY" ] || die "Antigravity CLI (agy) not installed. Install: curl -fsSL https://antigravity.google/cli/install.sh | bash   then run 'agy' once to sign in."
command -v python3 >/dev/null || die "python3 is required"
root="$(repo_root)"
model="$(cfg gemini_model gemini-4-neon-high)"; t="$(cfg gemini_timeout 900)"
# Antigravity also serves Claude and GPT models; a non-Gemini model would defeat the independent second opinion.
case "$model" in gemini-*) ;; *) die "gemini_model must be a Gemini model (got '$model'). See: agy models";; esac

workspace="$root"
agy_args=(--mode plan --model "$model")
if "$isolated"; then
  # Keep the live repository out of both the workspace and the prompt. All inputs are inline.
  workspace="$(mktemp -d "${TMPDIR:-/tmp}/trio-gemini.XXXXXXXX")" || die "could not create isolated workspace"
  trap 'rmdir "$workspace"' EXIT
  settings='{"toolPermission":"strict","permissions":{"deny":["read_file(*)","write_file(*)","command(*)","mcp(*)","read_url(*)","execute_url(*)"]}}'
  agy_args+=(--disable-slash-commands)
  prompt="Answer using only the inline material below. Reply in this message without calling tools, opening files, or asking for approval.

$(cat "$prompt_file")"
else
  # Antigravity ignores .geminiignore. Read its exact paths and add permissions ourselves.
  secrets="$(find_secrets "$root")"
  [ -f "$root/.geminiignore" ] && secrets+=$'\n'"$(grep -v -E '^[[:space:]]*(#|$)' "$root/.geminiignore" | grep -v '[*?]')"
  settings="$(SECRETS="$secrets" ROOT="$root" python3 -c '
import json, os
paths = sorted({(p.strip()[2:] if p.strip().startswith("./") else p.strip()) for p in os.environ["SECRETS"].splitlines() if p.strip()})
deny = ["write_file(*)", "command(*)", "mcp(*)"]
for p in paths:
    full = os.path.join(os.environ["ROOT"], p)
    deny += ["read_file(%s)" % p, "read_file(%s)" % full]
print(json.dumps({"permissions": {"deny": deny}}))')" || die "could not prepare Gemini permissions"

  # Give Gemini a file list up front for repo-aware analysis.
  files="$(git -C "$root" ls-files 2>/dev/null | grep -v '^\.multimodel/tasks/' | head -3000)"
  [ -z "$files" ] && files="$(cd "$root" && find . \( -path './.git' -o -path './.multimodel/tasks' -o -name node_modules \) -prune -o -type f -print | sed 's|^\./||' | head -3000)"
  [ -n "$secrets" ] && files="$(printf '%s\n' "$files" | grep -v -x -F -f <(printf '%s\n' "$secrets"))"

  prompt="You are running non-interactively as a read-only advisor. Use only your file-reading tools, with paths relative to the repository root. Do not create or edit files. Answer completely in this single reply; do not stop to ask for approval or to propose a plan for approval.

## Files in this repository
$files

## Your task
$(cat "$prompt_file")"
fi

for attempt in 1 2; do
  (cd "$workspace" && run_with_timeout $((t + 60)) "$AGY" -p "$prompt" "${agy_args[@]}" \
      --settings "$settings" --output-format json --print-timeout "${t}s" </dev/null) >"$out.raw" 2>"$out.err"
  rc=$?
  if grep -qiE 'authentication required|not (signed|logged) in|sign in|login' "$out.err" 2>/dev/null && ! [ -s "$out.raw" ]; then
    die "Antigravity is not signed in. Run 'agy' in a terminal once, sign in with Google, then retry."
  fi
  if python3 - "$out.raw" "$out" <<'PY'
import json, sys
raw, out = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(raw))
except Exception:
    sys.exit(1)
resp = (d.get("response") or "").strip()
if d.get("status") != "SUCCESS" or not resp:
    print(f"status={d.get('status')} error={d.get('error') or d.get('message')}", file=sys.stderr); sys.exit(1)
open(out, "w").write(resp + "\n")
meta = {k: d.get(k) for k in ("conversation_id", "duration_seconds", "num_turns", "usage", "denied_actions")}
json.dump(meta, open(out + ".meta.json", "w"), indent=2)
den = d.get("denied_actions") or []
print(f"OK: Gemini answered in {round(d.get('duration_seconds') or 0)}s -> {out} ({len(resp.splitlines())} lines)"
      + (f"; blocked actions: {', '.join(a.get('display_name','?') for a in den)}" if den else ""))
PY
  then rm -f "$out.raw" "$out.err"; exit 0; fi
  echo "Gemini attempt $attempt failed (exit $rc). Last error lines:" >&2; tail -5 "$out.err" >&2
  [ "$attempt" = 1 ] && sleep 15
done
echo "FAILED: see $out.err and $out.raw" >&2; exit 1
