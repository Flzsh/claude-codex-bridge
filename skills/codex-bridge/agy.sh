#!/usr/bin/env bash
# Run one Gemini job through Antigravity and print only its final answer.
# Usage: agy.sh <workdir> <brief-file>
#
# AGY_MODEL optionally selects the model. Effort: the one picked on the card
# (geminiEffort in <plugin>/settings.json), else AGY_EFFORT, else Antigravity's
# default. AGY_BIN picks the Antigravity executable.
#
# Each run gets a folder under <plugin>/runs with brief.md, log.txt, result.md
# and status.json; out.json holds the CLI's JSON response.
set -u

WORKDIR="${1:?workdir}"; BRIEF="${2:?brief file}"
# skills/codex-bridge/agy.sh -> the plugin's root, where runs/ and settings.json live.
PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Without AGY_MODEL, Antigravity picks its own default model; the card then just says "Gemini".
MODEL="${AGY_MODEL:-gemini}"
# The card writes settings.json as one line of JSON, letters only in the values.
PICKED="$(sed -n 's/.*"geminiEffort":"\([a-z]*\)".*/\1/p' "$PLUGIN_ROOT/settings.json" 2>/dev/null | head -1)"
EFFORT="${PICKED:-${AGY_EFFORT:-}}"

[ -f "$BRIEF" ] || { echo "brief file not found: $BRIEF" >&2; exit 2; }
[ -d "$WORKDIR" ] || { echo "workdir not found: $WORKDIR" >&2; exit 2; }

# AGY_BIN, else the Windows install, else `agy` on PATH.
AGY="${AGY_BIN:-}"
if [ -z "$AGY" ] && [ -n "${LOCALAPPDATA:-}" ] && [ -f "$LOCALAPPDATA/agy/bin/agy.exe" ]; then
  AGY="$LOCALAPPDATA/agy/bin/agy.exe"
fi
[ -n "$AGY" ] || AGY="agy"
command -v "$AGY" >/dev/null 2>&1 || [ -x "$AGY" ] || {
  echo "agy not found. Install Antigravity CLI: https://antigravity.google/download, then run agy once to sign in" >&2; exit 2;
}
# Absolute path, so a relative AGY_BIN still works after the cd into the workdir below.
case "$AGY" in
  */*|*\\*) AGY="$(cd "$(dirname -- "$AGY")" && pwd)/$(basename -- "$AGY")" ;;
  *) AGY="$(command -v "$AGY")" ;;
esac
command -v node >/dev/null 2>&1 || { echo "node not found. Install Node.js to parse Antigravity JSON output" >&2; exit 2; }

RUN="$PLUGIN_ROOT/runs/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$RUN" && cp -- "$BRIEF" "$RUN/brief.md" || { echo "could not set up $RUN" >&2; exit 2; }

# First non-empty line of the brief, made safe for JSON, as the job's title.
TITLE="$(grep -m1 -v '^[[:space:]]*$' "$RUN/brief.md" | tr '\t' ' ' | tr -d '\000-\037"\134' | cut -c1-90)"
# shellcheck source=project.sh
. "$(dirname "$0")/project.sh"
bridge_brief "$RUN/brief.md" "$RUN/sent.md"
START=$(date +%s)
write_status() { # state exit
  printf '{"provider":"gemini","origin":"%s","session":"%s","model":"%s","effort":"%s","title":"%s","workdir":"%s","startedAt":%s,"state":"%s","exit":%s,"endedAt":%s}\n' \
    "$(printf %s "${BRIDGE_ORIGIN:-claude}" | tr -cd "a-z")" "$SESSION" "$(printf %s "$MODEL" | tr -d '\000-\037"\134')" "$(printf %s "$EFFORT" | tr -d '\000-\037"\134')" "$TITLE" \
    "$(basename -- "$WORKDIR" | tr -d '\000-\037"\134')" "$START" "$1" "$2" \
    "$([ "$1" = running ] && echo null || date +%s)" > "$RUN/status.json.tmp" && mv -f "$RUN/status.json.tmp" "$RUN/status.json"
}

# AGY_CONVERSATION=<id> continues that Gemini conversation; ids are letters, digits and dashes.
RESUME="$(printf %s "${AGY_CONVERSATION:-}" | tr -cd 'A-Za-z0-9-')"
SESSION="$RESUME"

DONE=0
finish() {
  if [ "$DONE" != 1 ]; then
    write_status failed 130
    bridge_flow_finish 130
  fi
}
trap finish EXIT
trap 'exit 130' INT TERM HUP

AGY_ARGS=()
[ -z "${AGY_MODEL:-}" ] || AGY_ARGS+=(--model "$AGY_MODEL")
[ -z "$EFFORT" ] || AGY_ARGS+=(--effort "$EFFORT")
[ -z "$RESUME" ] || AGY_ARGS+=(--conversation "$RESUME")

# A long brief would pass Windows' ~32,000-character command-line limit, and agy does not
# read a plain-text prompt from stdin, so Gemini is told to read the brief from the run folder.
PROMPT="$(cat "$RUN/sent.md")"
# Quotes and backslashes are escaped on the Windows command line, so count them extra.
SIZE=$(( $(wc -c < "$RUN/sent.md") + 2 * $(tr -cd '"\\' < "$RUN/sent.md" | wc -c) ))
if [ "$SIZE" -gt 24000 ]; then
  BRIEF_PATH="$RUN/sent.md"
  command -v cygpath >/dev/null 2>&1 && BRIEF_PATH="$(cygpath -m "$BRIEF_PATH")"
  PROMPT="Read the file $BRIEF_PATH and do exactly what it says. That file is the whole task."
fi

bridge_flow_start gemini || bridge_flow_paused_exit
write_status running null
(cd "$WORKDIR" && "$AGY" -p "$PROMPT" --output-format json ${AGY_ARGS[@]+"${AGY_ARGS[@]}"}) > "$RUN/out.json" 2> "$RUN/log.txt"
CODE=$?
node -e '
const fs = require("fs");
const raw = fs.readFileSync(process.argv[1], "utf8");
try {
  const data = JSON.parse(raw);
  if (typeof data.conversation_id === "string") fs.writeFileSync(process.argv[3], data.conversation_id);
  if (data.status !== "SUCCESS") {
    console.error(typeof data.error === "string" ? data.error : JSON.stringify(data.error ?? data));
    process.exitCode = 1;
  } else {
    fs.writeFileSync(process.argv[2], data.response);
  }
} catch (error) {
  console.error(error.message + "\n" + raw);
  process.exitCode = 1;
}
' "$RUN/out.json" "$RUN/result.md" "$RUN/conversation.txt" >> "$RUN/log.txt" 2>&1
PARSE_CODE=$?
FOUND=""
[ ! -f "$RUN/conversation.txt" ] || FOUND="$(tr -cd 'A-Za-z0-9-' < "$RUN/conversation.txt")"
[ -z "$FOUND" ] || SESSION="$FOUND"
[ "$PARSE_CODE" = 0 ] || { [ "$CODE" != 0 ] || CODE=1; }
if [ "$CODE" = 0 ] && [ -s "$RUN/result.md" ]; then write_status done 0; else [ "$CODE" = 0 ] && CODE=1; write_status failed "$CODE"; fi
DONE=1
bridge_flow_finish "$CODE"
bridge_log "Gemini${AGY_MODEL:+ · $AGY_MODEL}${EFFORT:+ · $EFFORT}" "$RUN/result.md" "$CODE"

echo "model=$MODEL effort=$EFFORT exit=$CODE time=$(( $(date +%s) - START ))s run=$RUN session=$SESSION"
if [ -s "$RUN/result.md" ]; then
  cat "$RUN/result.md"; echo
else
  echo "NO RESULT. Last log lines:"
  grep -v '^[[:space:]]*$' "$RUN/log.txt" | tail -12 | cut -c1-300
fi
exit $CODE
