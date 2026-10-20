#!/usr/bin/env bash
# Run one Codex job for the codex-bridge skill and print only its final answer.
# Usage: pyr.sh <workdir> <brief-file> [read-only|workspace-write]
#
# Model and effort come from CODEX_BRIDGE_MODEL / CODEX_BRIDGE_EFFORT
# (defaults below); CODEX_BIN picks the codex executable.
#
# Each run gets a folder under <plugin>/runs with brief.md, log.txt, result.md
# and status.json; the plugin's Codex card reads status.json to show the job.
set -u

WORKDIR="${1:?workdir}"; BRIEF="${2:?brief file}"; SANDBOX="${3:-workspace-write}"
MODEL="${CODEX_BRIDGE_MODEL:-gpt-6.1-sol}"
EFFORT="${CODEX_BRIDGE_EFFORT:-xhigh}"

case "$SANDBOX" in read-only|workspace-write) ;; *) echo "sandbox must be read-only or workspace-write" >&2; exit 2 ;; esac
[ -f "$BRIEF" ] || { echo "brief file not found: $BRIEF" >&2; exit 2; }
[ -d "$WORKDIR" ] || { echo "workdir not found: $WORKDIR" >&2; exit 2; }

# CODEX_BIN, else the Codex desktop app's bundled CLI on Windows (it is often
# newer than an old npm install), else `codex` on PATH.
CX="${CODEX_BIN:-}"
if [ -z "$CX" ] && [ -n "${LOCALAPPDATA:-}" ]; then
  CX="$(ls -t "$LOCALAPPDATA"/OpenAI/Codex/bin/*/codex.exe 2>/dev/null | head -1)"
fi
[ -n "$CX" ] || CX="codex"
command -v "$CX" >/dev/null 2>&1 || [ -x "$CX" ] || {
  echo "codex not found. Install it (npm install -g @openai/codex) and run: codex login" >&2; exit 2;
}

# skills/codex-bridge/pyr.sh -> the plugin's root, where runs/ lives.
PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN="$PLUGIN_ROOT/runs/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$RUN" && cp -- "$BRIEF" "$RUN/brief.md" || { echo "could not set up $RUN" >&2; exit 2; }

# First non-empty line of the brief, made safe for JSON, as the job's title.
TITLE="$(grep -m1 -v '^[[:space:]]*$' "$RUN/brief.md" | tr '\t' ' ' | tr -d '\000-\037"\134' | cut -c1-90)"
START=$(date +%s)
write_status() { # state exit
  printf '{"model":"%s","effort":"%s","title":"%s","workdir":"%s","startedAt":%s,"state":"%s","exit":%s,"endedAt":%s}\n' \
    "$(printf %s "$MODEL" | tr -d '\000-\037"\134')" "$(printf %s "$EFFORT" | tr -d '\000-\037"\134')" "$TITLE" \
    "$(basename -- "$WORKDIR" | tr -d '\000-\037"\134')" "$START" "$1" "$2" \
    "$([ "$1" = running ] && echo null || date +%s)" > "$RUN/status.json.tmp" && mv -f "$RUN/status.json.tmp" "$RUN/status.json"
}

DONE=0
finish() { [ "$DONE" = 1 ] || write_status failed 130; }
trap finish EXIT
trap 'exit 130' INT TERM HUP

write_status running null
"$CX" exec --skip-git-repo-check -C "$WORKDIR" -s "$SANDBOX" \
  -m "$MODEL" -c model_reasoning_effort="$EFFORT" \
  -o "$RUN/result.md" - < "$RUN/brief.md" > "$RUN/log.txt" 2>&1
CODE=$?
if [ "$CODE" = 0 ] && [ -s "$RUN/result.md" ]; then write_status done 0; else [ "$CODE" = 0 ] && CODE=1; write_status failed "$CODE"; fi
DONE=1

echo "model=$MODEL effort=$EFFORT exit=$CODE time=$(( $(date +%s) - START ))s run=$RUN"
if [ -s "$RUN/result.md" ]; then
  cat "$RUN/result.md"; echo
else
  echo "NO RESULT. Last log lines:"
  grep -v '^[[:space:]]*$' "$RUN/log.txt" | tail -12 | cut -c1-300
fi
exit $CODE
