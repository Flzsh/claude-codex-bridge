#!/usr/bin/env bash
set -euo pipefail

script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/flow.sh"
unset BRIDGE_FLOW_ID BRIDGE_FLOW_SKIP_CHECK
temp_base="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)"
scratch="$(mktemp -d "$temp_base/bridge-flow.XXXXXX")"
background=
cleanup() {
  if [[ -n "$background" ]]; then
    kill "$background" 2>/dev/null || true
    wait "$background" 2>/dev/null || true
  fi
  local resolved
  resolved="$(cd -- "$scratch" && pwd -P)"
  if [[ "$resolved" == "$scratch" && "$resolved" == "$temp_base"/bridge-flow.* ]]; then
    rm -rf -- "$resolved"
  fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

export BRIDGE_WORKDIR="$scratch/work with spaces"
mkdir -- "$BRIDGE_WORKDIR"
native_workdir="$BRIDGE_WORKDIR"
if command -v cygpath >/dev/null 2>&1; then
  native_workdir="$(cygpath -am -- "$native_workdir")"
fi
control="$BRIDGE_WORKDIR/.bridge/control"
output="$scratch/output"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
equal() { [[ "$1" == "$2" ]] || fail "expected [$2], got [$1]"; }
flow() { bash "$script" "$@"; }
in_node() { MSYS2_ARG_CONV_EXCL='*' node -e "$1" -- "$native_workdir" "${@:2}"; }

start_background() {
  bash "$script" "$@" > "$output" &
  background=$!
}

await_background() {
  in_node '
    const fs = require("node:fs");
    const path = require("node:path");
    const [workdir, expected] = process.argv.slice(1);
    const end = Date.now() + 4000;
    function poll() {
      const output = fs.readFileSync(path.join(workdir, "..", "output"), "utf8");
      if (output.split("\n").includes(expected)) return;
      if (Date.now() >= end) throw new Error(`Expected ${expected}, got ${output}`);
      setTimeout(poll, 25);
    }
    poll();
  ' "$1"
}

finish_background() {
  wait "$background"
  background=
  equal "$(cat -- "$output")" "$1"
}

await_event() {
  in_node '
    const fs = require("node:fs");
    const path = require("node:path");
    const [workdir, id, state, paused] = process.argv.slice(1);
    const end = Date.now() + 4000;
    function poll() {
      const lines = fs.readFileSync(path.join(workdir, ".bridge", "flow.jsonl"), "utf8").split("\n");
      for (const line of lines) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.id === id && e.state === state && (paused === undefined || e.paused === (paused === "true"))) return;
      }
      if (Date.now() >= end) throw new Error(`No ${state} event for ${id}`);
      setTimeout(poll, 25);
    }
    poll();
  ' "$@"
}

special=$'"quoted" \\ path\n中文 ✓\r\nsecond line'
equal "$(flow check)" ''
[[ -d "$control" ]] || fail 'check did not create the control directory'
started="$(flow start "$special" --size large)"
first="${started#FLOW=}"
[[ "$started" == FLOW=f* ]] || fail "start output: $started"
equal "$(cat -- "$BRIDGE_WORKDIR/.bridge/flow-current")" "$first"
flow step build claude running "$special" --summary "$special" --progress /looks/like/a/path \
  --after ask,plan --phase 4 --run runs/job-7
flow say build '●' "$special"
flow meter build 12 - "$special"
flow meter build 13 20 words
started="$(flow start next)"
second="${started#FLOW=}"
[[ "$started" == FLOW=f* && "$first" != "$second" ]] || fail "second start output: $started"
BRIDGE_FLOW_ID="$first" flow step pinned codex done "$special"
# An empty override pins a standalone run even when a flow-current exists.
BRIDGE_FLOW_ID='' flow say legacy '>' "$special"
workdir="$BRIDGE_WORKDIR"
(unset BRIDGE_WORKDIR; cd -- "$workdir"; flow say cwd '⎿' "$special")

equal "$(flow gate auto 'review' --wait 2 --max 5 --summary "$special" --after ask,plan --phase 3)" GATE=auto
equal "$(flow wait auto)" GATE=auto

start_background gate manual 'review' --wait 5 --max 7
await_event manual waiting
sleep 1
flow answer approve --gate manual --text "$special"
await_background GATE=approve
finish_background GATE=approve
equal "$(flow answer decline --gate manual)" ANSWER=taken
equal "$(flow wait manual)" GATE=approve

# A desktop writer opens the marker just before the deadline and finishes after it.
start_background gate race 'review' --wait 2 --max 5
await_event race waiting
in_node '
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(process.argv[1], ".bridge");
  const gate = fs.readFileSync(path.join(dir, "flow.jsonl"), "utf8").trimEnd().split("\n")
    .map(line => JSON.parse(line)).find(e => e.id === "race");
  setTimeout(() => {
    const fd = fs.openSync(path.join(dir, "control", "gate-race.json"), "wx");
    fs.writeSync(fd, "{");
    setTimeout(() => {
      fs.writeSync(fd, JSON.stringify({ answer: "approve" }).slice(1));
      fs.closeSync(fd);
    }, Math.max(0, gate.until * 1000 + 350 - Date.now()));
  }, Math.max(0, gate.until * 1000 - 400 - Date.now()));
'
await_background GATE=approve
finish_background GATE=approve

start_background gate decline 'review' --no-auto --max 5
await_event decline waiting
flow answer decline --gate decline --text 'revise first'
await_background GATE=decline
finish_background GATE=decline
equal "$(flow wait decline)" GATE=decline

start_background gate paused 'review' --wait 2 --max 3
await_event paused waiting
sleep 0.5
flow answer pause --gate paused --text "$special"
await_event paused waiting true
sleep 3.1
[[ ! -s "$output" && ! -e "$control/gate-paused.json" ]] || fail 'gate expired during pause'
flow answer resume --gate paused --text 'continue review'
await_background GATE=auto
finish_background GATE=auto

# Approving a review that was paused while it waited is the go-ahead: the pause ends with it.
start_background gate held 'review the build' --no-auto --max 5
await_event held waiting
flow answer pause
await_event held waiting true
flow answer approve --gate held
await_background GATE=approve
finish_background GATE=approve
[[ ! -e "$control/pause.json" ]] || fail 'approving a paused review left the pause on'

start_background gate steer 'review' --no-auto --max 5
await_event steer waiting
flow answer steer --gate steer --text "$special"
await_background GATE=steer
finish_background "$(printf 'GATE=steer\nTEXT=%s' "$special")"

in_node '
  const fs = require("node:fs");
  const path = require("node:path");
  fs.writeFileSync(path.join(process.argv[1], ".bridge/control/gate-null-steer.json"),
    JSON.stringify({ answer: "steer", text: null, by: "you" }), { flag: "wx" });
'
equal "$(flow gate null-steer review --no-auto --max 1)" $'GATE=steer\nTEXT='

slice=$'GATE=waiting\nRESUME=flow.sh wait sliced'
equal "$(flow gate sliced 'review' --wait 3 --max 0.5 --done-title "$special")" "$slice"
start_background wait sliced
await_background GATE=waiting
finish_background "$slice"
sleep 2.1
equal "$(flow wait sliced)" GATE=auto
equal "$(flow wait sliced)" GATE=auto

equal "$(flow gate explicit 'needs your yes' --wait 0 --no-auto --max 0.25 --done-title 'ready to ship')" \
  $'GATE=waiting\nRESUME=flow.sh wait explicit'
[[ ! -e "$control/gate-explicit.json" ]] || fail 'a no-auto gate claimed an answer'
flow answer approve --gate explicit
equal "$(flow wait explicit)" GATE=approve

flow step older claude running 'older Claude step'
flow step current claude running 'current Claude step'
flow step retired claude running 'other Claude step'
flow step retired claude done 'other Claude step'
flow step older claude running 'updated older Claude step'
flow step runner codex running 'active runner'
BRIDGE_FLOW_ID="$first" flow step other-flow claude running 'Claude in the previous flow'
flow steer claude 'from CLI'
flow steer codex "$special"
# The same shape as a desktop steer, with an earlier timestamp in its filename.
in_node '
  const fs = require("node:fs");
  const path = require("node:path");
  fs.writeFileSync(path.join(process.argv[1], ".bridge/control/steer-9-app.json"),
    JSON.stringify({ text: "from desktop", by: "you", t: 0.009 }), { flag: "wx" });
'
flow answer pause
BRIDGE_FLOW_SKIP_CHECK=1 start_background step runner codex done 'runner finished'
await_event runner done
finish_background ''
start_background check
await_background PAUSED=1
equal "$(cat -- "$output")" PAUSED=1
[[ -e "$control/steer-9-app.json" ]] || fail 'check consumed a steer while paused'
flow answer resume
await_background 'STEER=from CLI'
finish_background $'PAUSED=1\nSTEER=from desktop\nSTEER=from CLI'
equal "$(flow check)" ''

flow steer claude 'during step check'
# a Codex or Gemini step leaves the steer for Claude
equal "$(flow step helper codex running 'helper step')" ''
equal "$(flow step next claude running next)" 'STEER=during step check'
flow steer claude 'once across two checkers'
start_background check
foreground="$(flow check)"
wait "$background"
background=
equal "$foreground$(cat -- "$output")" 'STEER=once across two checkers'
equal "$(flow check)" ''

if flow answer approve --gate '../bad' > /dev/null 2>&1; then fail 'accepted an unsafe gate id'; fi
if flow step invalid claude running title --phase NaN > /dev/null 2>&1; then fail 'accepted an invalid phase'; fi
if flow gate invalid review --wait -1 > /dev/null 2>&1; then fail 'accepted a negative wait'; fi
if flow wait missing > /dev/null 2>&1; then fail 'accepted an unknown gate'; fi
mkdir -p -- "$scratch/bad/.bridge/flow.jsonl"
if BRIDGE_WORKDIR="$scratch/bad" flow start blocked > /dev/null 2>&1; then fail 'hid an append failure'; fi
flow end --summary "$special"

in_node '
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const [workdir, text, first, second] = process.argv.slice(1);
  const dir = path.join(workdir, ".bridge");
  const lines = fs.readFileSync(path.join(dir, "flow.jsonl"), "utf8").split("\n");
  assert.equal(lines.pop(), "", "every event ends with a newline");
  const events = lines.map(line => JSON.parse(line));
  assert(events.every(e => Number.isFinite(e.t) && Math.abs(e.t - Date.now() / 1000) < 120));
  const find = (id, state) => events.find(e => e.id === id && (state === undefined || e.state === state));
  const gateEvents = id => events.filter(e => e.id === id);
  const firstFlow = events[0];
  assert.deepEqual(firstFlow, { t: firstFlow.t, kind: "flow", title: text, size: "large", flow: first });
  const step = find("build");
  assert.deepEqual(step, { t: step.t, flow: first, id: "build", lane: "claude", kind: "step",
    state: "running", title: text, summary: text, progress: "/looks/like/a/path", after: ["ask", "plan"], phase: 4, run: "runs/job-7" });
  assert.deepEqual(events.find(e => e.id === "build" && e.log).log, ["●", text]);
  assert.deepEqual(events.filter(e => e.id === "build" && e.meter).map(e => e.meter), [[12, null, text], [13, 20, "words"]]);
  assert.equal(find("pinned").flow, first);
  assert.equal(Object.hasOwn(find("legacy"), "flow"), false);
  assert.deepEqual(find("cwd").log, ["⎿", text]);
  assert.equal(find("cwd").flow, second);
  assert.deepEqual(events.at(-1), { t: events.at(-1).t, kind: "flow", flow: second, state: "done", summary: text });

  const auto = find("auto", "waiting");
  assert.equal(auto.lane, "you");
  assert.equal(auto.kind, "gate");
  assert.equal(auto.wait, 2);
  assert.equal(auto.until, auto.t + 2);
  assert.deepEqual(auto.after, ["ask", "plan"]);
  assert.equal(auto.phase, 3);
  assert.equal(auto.summary, text);
  assert(find("auto", "done").t >= auto.until);
  assert.equal(find("auto", "done").auto, true);
  assert.equal(find("auto", "done").summary, "nobody answered in 2 s, so it carried on");
  const autoAnswers = events.filter(e => e.gate === "auto" && e.answer);
  assert.equal(autoAnswers.length, 1);
  assert.equal(autoAnswers[0].id, undefined);
  assert.equal(autoAnswers[0].answer, "approve");
  assert.equal(autoAnswers[0].auto, true);
  for (const id of ["auto", "manual", "race", "decline", "paused", "held", "sliced", "explicit"]) {
    assert.equal(gateEvents(id).filter(e => e.state === "done" || e.state === "failed").length, 1, id);
  }
  assert.equal(find("manual", "done").summary, "approved by you");
  assert.equal(find("manual", "done").title, "approved the plan");
  assert.equal(find("held", "done").title, "approved the build");
  assert.equal(events.find(e => e.answer === "approve" && e.gate === "manual").text, text);
  assert.equal(find("race", "done").auto ?? false, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "control/gate-race.json"), "utf8")), { answer: "approve" });
  assert.equal(find("decline", "failed").summary, "revise first");
  // a review answered with a change closes as "asked for changes", carrying the change
  assert.equal(gateEvents("steer").at(-1).state, "done");
  assert.equal(gateEvents("steer").at(-1).title, "asked for changes");
  assert.equal(gateEvents("steer").at(-1).summary, text);
  assert.equal(events.find(e => e.answer === "steer" && e.gate === "steer").text, text);
  assert.equal(gateEvents("null-steer").at(-1).state, "done");
  const paused = gateEvents("paused").find(e => e.paused === true);
  const resumed = gateEvents("paused").find(e => e.paused === false && e.t > paused.t);
  assert.equal(paused.state, "waiting");
  assert.equal(Object.hasOwn(paused, "until"), false);
  assert.equal(resumed.state, "waiting");
  assert.equal(resumed.until, resumed.t + 2);
  assert(find("paused", "done").t >= resumed.until);
  assert.equal(gateEvents("sliced").filter(e => e.state === "waiting").length, 1);
  assert.equal(find("sliced", "done").title, text);
  assert.equal(find("explicit", "waiting").noAuto, true);
  assert.equal(Object.hasOwn(find("explicit", "waiting"), "until"), false);
  assert.equal(find("explicit", "done").title, "ready to ship");

  assert.deepEqual(events.filter(e => e.answer === "pause" || e.answer === "resume").map(e => [e.id, e.answer, e.gate, e.text]),
    [[undefined, "pause", "paused", text], [undefined, "resume", "paused", "continue review"],
      [undefined, "pause", undefined, undefined], [undefined, "resume", undefined, undefined],
      [undefined, "pause", undefined, undefined], [undefined, "resume", undefined, undefined]]);
  assert.equal(events.find(e => e.kind === "steer" && e.to === "codex").summary, text);
  assert(events.filter(e => e.kind === "steer").every(e => e.state === "done" && e.lane === "you"));
  const receipts = events.filter(e => e.log?.[1] === "steer received");
  assert.deepEqual(receipts.map(e => [e.id, e.flow, e.log[0]]), [
    ["current", second, "✓"], ["current", second, "✓"], ["current", second, "✓"], ["next", second, "✓"],
  ]);
  assert(events.indexOf(receipts[2]) < events.indexOf(find("next")), "step must check before appending");
  const control = fs.readdirSync(path.join(dir, "control"));
  assert.equal(control.filter(name => name.endsWith(".taken")).length, 4);
  assert(!control.some(name => /^steer-.*\.json$/.test(name)));
  assert(!control.includes("pause.json"));
' "$special" "$first" "$second"

printf '%s\n' 'flow.sh tests passed'
