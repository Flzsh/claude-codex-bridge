#!/usr/bin/env bash
# Run one Gemini job through Antigravity and print only its final answer.
# Usage: agy.sh <workdir> <brief-file>
#
# AGY_MODEL / AGY_EFFORT optionally select the model and effort;
# AGY_BIN picks the Antigravity executable.
#
# Each run gets a folder under <plugin>/runs with brief.md, log.txt, result.md
# and status.json; out.json holds the CLI's JSON response.
set -u

WORKDIR="${1:?workdir}"; BRIEF="${2:?brief file}"
# Without AGY_MODEL, Antigravity picks its own default model; the card then just says "Gemini".
MODEL="${AGY_MODEL:-gemini}"
EFFORT="${AGY_EFFORT:-}"

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

# skills/codex-bridge/agy.sh -> the plugin's root, where runs/ lives.
PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN="$PLUGIN_ROOT/runs/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$RUN" && cp -- "$BRIEF" "$RUN/brief.md" || { echo "could not set up $RUN" >&2; exit 2; }

# First non-empty line of the brief, made safe for JSON, as the job's title.
TITLE="$(grep -m1 -v '^[[:space:]]*$' "$RUN/brief.md" | tr '\t' ' ' | tr -d '\000-\037"\134' | cut -c1-90)"
START=$(date +%s)
write_status() { # state exit
  printf '{"provider":"gemini","model":"%s","effort":"%s","title":"%s","workdir":"%s","startedAt":%s,"state":"%s","exit":%s,"endedAt":%s}\n' \
    "$(printf %s "$MODEL" | tr -d '\000-\037"\134')" "$(printf %s "$EFFORT" | tr -d '\000-\037"\134')" "$TITLE" \
    "$(basename -- "$WORKDIR" | tr -d '\000-\037"\134')" "$START" "$1" "$2" \
    "$([ "$1" = running ] && echo null || date +%s)" > "$RUN/status.json.tmp" && mv -f "$RUN/status.json.tmp" "$RUN/status.json"
}

DONE=0
finish() { [ "$DONE" = 1 ] || write_status failed 130; }
trap finish EXIT
trap 'exit 130' INT TERM HUP

AGY_ARGS=()
[ -z "${AGY_MODEL:-}" ] || AGY_ARGS+=(--model "$AGY_MODEL")
[ -z "${AGY_EFFORT:-}" ] || AGY_ARGS+=(--effort "$AGY_EFFORT")

# A long brief would pass Windows' ~32,000-character command-line limit, and agy does not
# read a plain-text prompt from stdin, so Gemini is told to read the brief from the run folder.
PROMPT="$(cat "$RUN/brief.md")"
# Quotes and backslashes are escaped on the Windows command line, so count them extra.
SIZE=$(( $(wc -c < "$RUN/brief.md") + 2 * $(tr -cd '"\\' < "$RUN/brief.md" | wc -c) ))
if [ "$SIZE" -gt 24000 ]; then
  BRIEF_PATH="$RUN/brief.md"
  command -v cygpath >/dev/null 2>&1 && BRIEF_PATH="$(cygpath -m "$BRIEF_PATH")"
  PROMPT="Read the file $BRIEF_PATH and do exactly what it says. That file is the whole task."
fi

write_status running null
(cd "$WORKDIR" && "$AGY" -p "$PROMPT" --output-format json ${AGY_ARGS[@]+"${AGY_ARGS[@]}"}) > "$RUN/out.json" 2> "$RUN/log.txt"
CODE=$?
node -e '
const fs = require("fs");
const raw = fs.readFileSync(process.argv[1], "utf8");
try {
  const data = JSON.parse(raw);
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
' "$RUN/out.json" "$RUN/result.md" >> "$RUN/log.txt" 2>&1
PARSE_CODE=$?
[ "$PARSE_CODE" = 0 ] || { [ "$CODE" != 0 ] || CODE=1; }
if [ "$CODE" = 0 ] && [ -s "$RUN/result.md" ]; then write_status done 0; else [ "$CODE" = 0 ] && CODE=1; write_status failed "$CODE"; fi
DONE=1

echo "model=$MODEL exit=$CODE time=$(( $(date +%s) - START ))s run=$RUN"
if [ -s "$RUN/result.md" ]; then
  cat "$RUN/result.md"; echo
else
  echo "NO RESULT. Last log lines:"
  grep -v '^[[:space:]]*$' "$RUN/log.txt" | tail -12 | cut -c1-300
fi
exit $CODE
