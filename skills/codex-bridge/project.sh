# Shared project helpers for pyr.sh and agy.sh (sourced, not run).
#
# A project is a .bridge/ folder in the working folder, made by /project start in
# the console or by Claude: project.md (goal, who does what, decisions) and log.md
# (what each agent was asked and answered). Claude, Codex and Gemini all read it,
# so what one learns the others see. BRIDGE_PROJECT=off skips it for a job.

# The project folder, or nothing when there is none (or it is switched off).
bridge_dir() {
  [ "${BRIDGE_PROJECT:-on}" != off ] && [ -f "$WORKDIR/.bridge/project.md" ] && printf %s "$WORKDIR/.bridge"
}

# bridge_brief <brief> <out>: the text the agent is sent. In a project it starts
# with a pointer to the shared files; otherwise it is the brief as written.
bridge_brief() {
  if [ -n "$(bridge_dir)" ]; then
    {
      printf '%s\n\n' "This task belongs to a shared project worked on by Claude, Codex and Gemini. Before answering, read .bridge/project.md (goal, who does what, decisions) and the last entries of .bridge/log.md (recent work) in the working folder. Don't edit those two files unless this task asks you to; your reply is added to the log for the others."
      cat -- "$1"
    } > "$2"
  else
    cp -- "$1" "$2"
  fi
}

# bridge_log <who> <reply-file> <exit>: adds this run to .bridge/log.md.
bridge_log() {
  local dir
  dir="$(bridge_dir)"
  [ -n "$dir" ] || return 0
  {
    printf '\n## %s · %s · %s\n\n' "$(date '+%Y-%m-%d %H:%M')" "$1" "$TITLE"
    if [ "$3" = 0 ] && [ -s "$2" ]; then
      head -n 60 -- "$2"
      printf '\n'
      [ "$(wc -l < "$2")" -le 60 ] || printf '\n(cut at 60 lines; the whole reply is in %s)\n' "$2"
    else
      printf '(no reply, exit %s)\n' "$3"
    fi
  } >> "$dir/log.md"
}

# A run keeps the same flow even if another workflow starts before it finishes.
FLOW_ACTIVE=0
FLOWTAIL_PID=''
bridge_flow_start() {
  [ -n "${BRIDGE_STEP:-}" ] || return 0
  FLOW_WORKDIR="${BRIDGE_WORKDIR:-$WORKDIR}"
  [ "${BRIDGE_FLOW:-}" = on ] || [ -n "$(WORKDIR="$FLOW_WORKDIR" bridge_dir)" ] || return 0
  FLOW_SCRIPT="$(dirname "$0")/flow.sh"
  FLOW_LANE="$1"
  FLOW_TITLE="${BRIDGE_STEP_TITLE:-$TITLE}"
  FLOW_ID="${BRIDGE_FLOW_ID-}"
  if [ -z "${BRIDGE_FLOW_ID+x}" ] && [ -f "$FLOW_WORKDIR/.bridge/flow-current" ]; then
    IFS= read -r FLOW_ID < "$FLOW_WORKDIR/.bridge/flow-current" || :
    FLOW_ID="${FLOW_ID%$'\r'}"
  fi

  local args=(step "$BRIDGE_STEP" "$FLOW_LANE" running "$FLOW_TITLE" --run "${RUN##*/}")
  [ -z "${BRIDGE_AFTER:-}" ] || args+=(--after "$BRIDGE_AFTER")
  [ -z "${BRIDGE_PHASE:-}" ] || args+=(--phase "$BRIDGE_PHASE")
  local output code=0
  output="$(BRIDGE_WORKDIR="$FLOW_WORKDIR" BRIDGE_FLOW_ID="$FLOW_ID" BRIDGE_FLOW_SKIP_CHECK='' bash "$FLOW_SCRIPT" "${args[@]}")" || code=$?
  [ -z "$output" ] || printf '%s\n' "$output" >&2
  [ "$output" != $'PAUSED=1\nPAUSED=still' ] || return 125
  [ "$code" != 0 ] || FLOW_ACTIVE=1
}

# The pause check gave up before it wrote the running step or launched a job.
bridge_flow_paused_exit() {
  write_status failed 125
  DONE=1
  printf '%s\n' 'Flow is still paused.' > "$RUN/log.txt"
  printf 'model=%s effort=%s exit=125 time=%ss run=%s session=%s\n' \
    "$MODEL" "$EFFORT" "$(( $(date +%s) - START ))" "$RUN" "$SESSION"
  cat "$RUN/log.txt"
  exit 125
}

bridge_flow_finish() {
  [ "${FLOW_ACTIVE:-0}" = 1 ] || return 0
  FLOW_ACTIVE=0
  if [ -n "${FLOWTAIL_PID:-}" ]; then
    if ! : > "$RUN/flowtail.stop"; then kill "$FLOWTAIL_PID" 2>/dev/null || :; fi
    wait "$FLOWTAIL_PID" || :
    rm -f -- "$RUN/flowtail.stop"
  fi

  local state=failed summary=''
  [ "$1" != 0 ] || state=done
  if [ -s "$RUN/result.md" ]; then
    summary="$(node -e '
const reply = require("node:fs").readFileSync(process.argv[1], "utf8");
const line = reply.split(/\r?\n/).find(line => line.trim()) ?? "";
process.stdout.write([...line].slice(0, 120).join(""));
' "$RUN/result.md")"
  fi
  # Pausing holds the next step. A run that has already finished can report it.
  BRIDGE_WORKDIR="$FLOW_WORKDIR" BRIDGE_FLOW_ID="$FLOW_ID" BRIDGE_FLOW_SKIP_CHECK=1 \
    bash "$FLOW_SCRIPT" step "$BRIDGE_STEP" "$FLOW_LANE" "$state" "$FLOW_TITLE" --summary "$summary" >&2 || :
}
