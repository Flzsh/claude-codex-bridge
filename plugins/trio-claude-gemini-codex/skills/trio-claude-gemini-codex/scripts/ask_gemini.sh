#!/usr/bin/env bash
# Usage: ask_gemini.sh <prompt-file> <out-file>
# Sends a prompt to Gemini through the Antigravity CLI (agy), headless and read-only (plan mode),
# from the repo root, pinned to a Gemini model. Retries once. Writes the answer to <out-file>
# and run details (time, tokens, denied tool calls) to <out-file>.meta.json.
# Attach images or files by writing @relative/path in the prompt.
set -uo pipefail
source "$(dirname "$0")/_lib.sh"
[ $# -eq 2 ] || [ $# -eq 3 ] || die "usage: ask_gemini.sh <prompt-file> <out-file> [--contract-only]"
contract_only=false
if [ "${1-}" = --isolated ]; then
  contract_only=true
  shift
fi
if [ $# -eq 3 ]; then
  [ "$3" = --contract-only ] || die "unknown option: $3"
  contract_only=true
fi
[ -f "$1" ] || die "prompt file not found: $1"
prompt_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
mkdir -p "$(dirname "$2")" || die "cannot create output directory"; out="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
AGY="$(agy_bin)" || true
[ -n "$AGY" ] || die "Antigravity CLI (agy) not installed. Install: curl -fsSL https://antigravity.google/cli/install.sh | bash   then run 'agy' once to sign in."
command -v python3 >/dev/null || die "python3 is required"
root="$(repo_root)"
model="$(cfg gemini_model gemini-4-neon-high)" || die "cannot read config"; t="$(cfg gemini_timeout 900)" || die "cannot read config"
# Antigravity also serves Claude and GPT models; a non-Gemini model would defeat the independent second opinion.
case "$model" in gemini-*) ;; *) die "gemini_model must be a Gemini model (got '$model'). See: agy models";; esac
valid_timeout "$t" || die "invalid gemini_timeout: $t"

# Block secret-looking files by exact path (agy ignores .geminiignore; glob deny rules don't match).
secrets="$(find_secrets "$root")" || die "cannot determine Gemini exclusions"
settings="$(SECRETS="$secrets" ROOT="$root" python3 -c '
import json, os
paths = sorted({(p[2:] if p.startswith("./") else p) for p in os.environ["SECRETS"].splitlines() if p.strip()})
deny = ["write_file(*)", "command(*)", "mcp(*)"]
for p in paths:
    full = os.path.join(os.environ["ROOT"], p)
    deny += ["read_file(%s)" % p, "read_file(%s)" % full]
    if not os.path.isabs(p):
        deny += ["read_file(./%s)" % p]
    deny += ["read_file(%s)" % os.path.realpath(full)]
print(json.dumps({"permissions": {"deny": sorted(set(deny))}}))')" || die "cannot prepare Gemini exclusions"

# In plan mode Gemini can open files but not list folders, so give it the file list up front.
files="$(git -C "$root" ls-files 2>/dev/null | grep -v '^\.multimodel/tasks/' | head -3000)"
[ -z "$files" ] && files="$(cd "$root" && find . \( -path './.git' -o -path './.multimodel/tasks' -o -name node_modules \) -prune -o -type f -print | sed 's|^\./||' | head -3000)"
[ -n "$secrets" ] && files="$(printf '%s\n' "$files" | grep -v -x -F -f <(printf '%s\n' "$secrets"))"

prompt="You are running non-interactively as a read-only advisor. Shell commands are disabled: never run terminal or Bash commands. Use only your file-reading tools, with paths relative to the repository root. Do not create or edit files. Answer completely in this single reply; do not stop to ask for approval or to propose a plan for approval.

## Files in this repository
$files

## Your task
$(cat "$prompt_file")"

lock_run "$out.lock"
begin_locked_run "$out"
attempt_dir="$(mktemp -d "$(dirname "$out")/.gemini.XXXXXX")" || die "cannot create attempt directory"
call_root="$root"
agy_args=(--mode plan --model "$model")
if "$contract_only"; then
  call_root="$(mktemp -d "${TMPDIR:-/tmp}/trio-contract.XXXXXX")" || die "cannot create isolated directory"
  settings='{"toolPermission":"strict","permissions":{"deny":["read_file(*)","write_file(*)","command(*)","mcp(*)","read_url(*)","execute_url(*)"]}}'
  agy_args+=(--disable-slash-commands)
  prompt="You are a read-only test author. Work exclusively from the supplied contract; do not read files, use tools, or access the project. Answer in this reply.

$(cat "$prompt_file")"
  trap 'rc=$?; rmdir "$call_root" 2>/dev/null || true; if [ "$rc" -eq 0 ]; then state=succeeded; else state=failed; fi; run_state "$run_artifact" "$state" "$rc" || rc=1; rmdir "$run_lock" 2>/dev/null || true; exit "$rc"' EXIT
fi
for old in "$out" "$out.meta.json" "$out.raw" "$out.err"; do
  [ ! -e "$old" ] || mv "$old" "$attempt_dir/previous-$(basename "$old")" || die "cannot archive previous Gemini output"
done
for attempt in 1 2; do
  raw="$attempt_dir/attempt-$attempt.raw"; err="$attempt_dir/attempt-$attempt.err"
  (cd "$call_root" && run_with_timeout "$t" "$AGY" -p "$prompt" "${agy_args[@]}" \
      --settings "$settings" --output-format json --print-timeout "${t}s" </dev/null) >"$raw" 2>"$err"
  rc=$?
  cp "$raw" "$out.raw" && cp "$err" "$out.err" || die "cannot save diagnostics"
  if grep -qiE 'authentication required|not (signed|logged) in|sign in|login' "$out.err" 2>/dev/null && ! [ -s "$out.raw" ]; then
    die "Antigravity is not signed in. Run 'agy' in a terminal once, sign in with Google, then retry."
  fi
  if [ "$rc" -eq 0 ] && python3 - "$raw" "$attempt_dir/result-$attempt.md" <<'PY'
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
  then
    mv "$attempt_dir/result-$attempt.md.meta.json" "$out.meta.json" && mv "$attempt_dir/result-$attempt.md" "$out" || die "cannot publish Gemini result"
    echo "OK: Gemini answer saved to $out"
    rm -f "$out.raw" "$out.err"; exit 0
  fi
  echo "Gemini attempt $attempt failed (exit $rc). Last error lines:" >&2; tail -5 "$out.err" >&2
  [ "$attempt" = 1 ] && sleep 15
done
echo "FAILED: see $out.err and $out.raw" >&2; exit 1
