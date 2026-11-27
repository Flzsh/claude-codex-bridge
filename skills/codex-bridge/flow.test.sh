#!/usr/bin/env bash
set -euo pipefail

script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/flow.sh"
unset BRIDGE_FLOW_ID BRIDGE_FLOW_SKIP_CHECK
temp_base="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)"
scratch="$(mktemp -d "$temp_base/bridge-flow.XXXXXX")"
export BRIDGE_REGISTRY_DIR="$scratch/registry"
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

assert_registry() {
  in_node '
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const [workdir, flow, ...args] = process.argv.slice(1);
    const record = JSON.parse(fs.readFileSync(path.join(workdir, "..", "registry", flow + ".json"), "utf8"));
    const events = fs.readFileSync(path.join(workdir, ".bridge", "flow.jsonl"), "utf8").trimEnd().split("\n")
      .map(line => JSON.parse(line)).filter(event => event.flow === flow);
  '"$2" "$1" "${@:3}"
}

assert_start_record() {
  assert_registry "$1" '
    const [title, size] = args;
    const start = events[0];
    assert.equal(record.v, 1);
    assert.equal(record.flow, flow);
    assert.equal(record.workdir, workdir);
    assert.equal(record.title, title);
    assert.equal(record.size, size || null);
    assert.equal(record.t0, start.t);
    assert.equal(record.t, start.t);
    assert.equal(record.state, "live");
    assert.equal(record.gate, null);
    assert.equal(record.paused, false);
  ' "$2" "${3:-}"
}

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

steps_error="$scratch/steps-error"
assert_steps() {
  local size="$1" workflow="$2" expected="$3"
  local expected_output="$scratch/steps-expected"
  printf '%s\n' "$expected" > "$expected_output"
  BRIDGE_WORKFLOW_FILE="$workflow" flow steps "$size" > "$output" 2> "$steps_error" ||
    fail "steps $size failed: $(cat -- "$steps_error")"
  diff -u -- "$expected_output" "$output" || fail "unexpected steps $size output"
}

default_small='0 ask | Ask | You | -
1 build | Do | Claude | -
2 ship | Check | Claude, You | -'
default_medium='0 ask | Ask | You | -
1 plan | Plan | Claude | -
2 build | Build | Claude, Codex | codex builds one bounded block
3 review | Review | Codex, Gemini | 1 review round
4 ship | Check & ship | Claude, You | -'
default_large='0 ask | Ask | You | -
1 plan | Two plans | Claude, Gemini | -
2 merge | Merge | Claude | -
3 decide | Decide | You | you review after it: carries on after the wait
4 build | Build | Claude, Codex | codex builds every backend block, claude the UI
5 review | Review | Gemini, Codex | 2 review rounds
6 ship | Check & ship | Claude, You | -'

missing_workflow="$native_workdir/missing-workflow.json"
assert_steps small "$missing_workflow" "$default_small"
assert_steps medium "$missing_workflow" "$default_medium"
assert_steps large "$missing_workflow" "$default_large"

cat > "$BRIDGE_WORKDIR/custom-workflow.json" <<'JSON'
{"v":1,"sizes":{"medium":[
  {"kind":"ask","label":"Ask","who":["you"]},
  {"kind":"plan","label":"Plan","who":["claude"]},
  {"kind":"build","label":"Build backend","who":["codex"],"codex":"all","gate":"yes"},
  {"kind":"review","label":"Gemini review","who":["gemini"],"rounds":2},
  {"kind":"ship","label":"Check & ship","who":["claude","you"]}
]}}
JSON
assert_steps medium "$native_workdir/custom-workflow.json" '0 ask | Ask | You | -
1 plan | Plan | Claude | -
2 build | Build backend | Codex | codex builds every backend block; you review after it: needs your yes
3 review | Gemini review | Gemini | 2 review rounds
4 ship | Check & ship | Claude, You | -'

printf '%s\n' '{' > "$BRIDGE_WORKDIR/bad-workflow.json"
assert_steps large "$native_workdir/bad-workflow.json" "$default_large"
grep -iq default "$steps_error" || fail "missing default note for malformed JSON: $(cat -- "$steps_error")"

cat > "$BRIDGE_WORKDIR/invalid-workflow.json" <<'JSON'
{"v":1,"sizes":{"medium":[
  {"kind":"ask","label":"Ask","who":["you"]},
  {"kind":"plan","label":"Plan","who":["claude"]},
  {"kind":"build","label":"Build","who":["claude"]},
  {"kind":"review","label":"Review","who":["gemini"],"rounds":3},
  {"kind":"ship","label":"Check & ship","who":["claude","you"]}
]}}
JSON
assert_steps medium "$native_workdir/invalid-workflow.json" "$default_medium"
grep -iq default "$steps_error" || fail "missing default note for invalid medium: $(cat -- "$steps_error")"
[[ ! -e "$control" ]] || fail 'steps created the control directory'

special=$'"quoted" \\ path\n中文 ✓\r\nsecond line'
equal "$(flow check)" ''
[[ -d "$control" ]] || fail 'check did not create the control directory'
BRIDGE_FLOW_ID='' flow say legacy '>' "$special"
[[ ! -e "$BRIDGE_REGISTRY_DIR" ]] || fail 'legacy event created a registry'
started="$(flow start "$special" --size large)"
first="${started#FLOW=}"
[[ "$started" == FLOW=f* ]] || fail "start output: $started"
equal "$(cat -- "$BRIDGE_WORKDIR/.bridge/flow-current")" "$first"
assert_start_record "$first" "$special" large
flow step build claude running "$special" --summary "$special" --progress /looks/like/a/path \
  --after ask,plan --phase 4 --run runs/job-7
assert_registry "$first" '
  assert(record.t > record.t0, "step did not advance the registry timestamp");
'
flow say build '●' "$special"
flow meter build 12 - "$special"
flow meter build 13 20 words
assert_registry "$first" 'assert.equal(record.t, events.at(-1).t);'
started="$(flow start 'small run' --size small)"
small="${started#FLOW=}"
[[ "$started" == FLOW=f* ]] || fail "small start output: $started"
assert_start_record "$small" 'small run' small
for damage in missing corrupt; do
  if [[ "$damage" == missing ]]; then
    rm -- "$BRIDGE_REGISTRY_DIR/$small.json"
  else
    printf '%s' '{' > "$BRIDGE_REGISTRY_DIR/$small.json"
  fi
  BRIDGE_FLOW_ID="$small" flow say "recovered-$damage" '>' 'registry recovery'
  assert_registry "$small" '
    assert.equal(record.v, 1);
    assert.equal(record.flow, flow);
    assert.equal(record.title, "small run");
    assert.equal(record.size, "small");
    assert.equal(record.t0, events[0].t);
    assert.equal(record.t, events.at(-1).t);
  '
done
started="$(flow start next)"
second="${started#FLOW=}"
[[ "$started" == FLOW=f* && "$first" != "$second" ]] || fail "second start output: $started"
assert_start_record "$second" next
scoped="$control/$second"
BRIDGE_FLOW_ID="$first" flow step pinned codex done "$special"
BRIDGE_FLOW_ID='' flow say pinned-empty '>' "$special"
workdir="$BRIDGE_WORKDIR"
(unset BRIDGE_WORKDIR; cd -- "$workdir"; flow say cwd '⎿' "$special")

equal "$(flow gate auto 'review' --wait 2 --max 5 --summary "$special" --after ask,plan --phase 3)" GATE=auto
equal "$(flow wait auto)" GATE=auto

start_background gate manual 'review' --wait 5 --max 0.5
await_background GATE=waiting
finish_background $'GATE=waiting\nRESUME=flow.sh wait manual'
assert_registry "$second" '
  const gate = events.find(event => event.id === "manual" && event.state === "waiting");
  assert.equal(record.gate.id, "manual");
  assert.equal(record.gate.title, "review");
  assert.equal(record.gate.until, gate.until);
  assert.equal(record.gate.until, gate.t + 5);
  assert.equal(record.gate.noAuto, false);
'
flow answer approve --gate manual --text "$special"
[[ -f "$scoped/gate-manual.json" && ! -e "$control/gate-manual.json" ]] || fail 'CLI gate answer was not scoped'
assert_registry "$second" 'assert.equal(record.gate, null);'
equal "$(flow wait manual)" GATE=approve
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

# Leave enough of the active slice for the restarted timer, including shell startup.
start_background gate paused 'review' --wait 2 --max 5
await_event paused waiting
sleep 0.5
flow answer pause --gate paused --text "$special"
await_event paused waiting true
sleep 5.1
[[ ! -s "$output" && ! -e "$scoped/gate-paused.json" ]] || fail 'gate expired during pause'
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
[[ ! -e "$scoped/pause.json" ]] || fail 'approving a paused review left the pause on'

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
[[ ! -e "$scoped/gate-explicit.json" ]] || fail 'a no-auto gate claimed an answer'
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
compgen -G "$scoped/steer-*.json" > /dev/null || fail 'CLI steer was not scoped'
if compgen -G "$control/steer-*.json" > /dev/null; then fail 'CLI steer wrote a flat marker'; fi
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

first_control="$control/$first"
BRIDGE_FLOW_ID="$first" flow answer pause
[[ -f "$first_control/pause.json" && ! -e "$scoped/pause.json" && ! -e "$control/pause.json" ]] ||
  fail 'pause was not scoped to the first flow'
assert_registry "$first" 'assert.equal(record.paused, true);'
assert_registry "$second" 'assert.equal(record.paused, false);'
BRIDGE_FLOW_ID="$second" start_background step unpaused codex done 'second flow keeps running'
await_event unpaused done
finish_background ''
BRIDGE_FLOW_ID="$first" start_background check
await_background PAUSED=1
BRIDGE_FLOW_ID="$first" flow answer resume
finish_background PAUSED=1
[[ ! -e "$first_control/pause.json" ]] || fail 'resume left a scoped pause on'
assert_registry "$first" 'assert.equal(record.paused, false);'

printf '%s\n' '{}' > "$control/pause.json"
BRIDGE_FLOW_ID="$first" flow answer pause
BRIDGE_FLOW_ID="$first" flow answer resume
# a resume lifts a shared pause an older build left too, so Resume always resumes
[[ ! -e "$control/pause.json" && ! -e "$first_control/pause.json" ]] ||
  fail 'resume left a shared or scoped pause on'
# a shared pause holds every flow
printf '%s\n' '{}' > "$control/pause.json"
BRIDGE_FLOW_ID="$second" start_background check
await_background PAUSED=1
rm -- "$control/pause.json"
finish_background PAUSED=1

shared=$'GATE=waiting\nRESUME=flow.sh wait shared'
equal "$(BRIDGE_FLOW_ID="$first" flow gate shared 'first review' --no-auto --max 0.25)" "$shared"
equal "$(BRIDGE_FLOW_ID="$second" flow gate shared 'second review' --no-auto --max 0.25)" "$shared"
equal "$(BRIDGE_FLOW_ID="$first" flow answer approve --gate shared)" ''
equal "$(BRIDGE_FLOW_ID="$first" flow wait shared)" GATE=approve
[[ -f "$first_control/gate-shared.json" && ! -e "$scoped/gate-shared.json" && ! -e "$control/gate-shared.json" ]] ||
  fail 'first flow answered the second flow gate'
equal "$(BRIDGE_FLOW_ID="$second" flow answer decline --gate shared --text 'second only')" ''
equal "$(BRIDGE_FLOW_ID="$second" flow wait shared)" GATE=decline
[[ -f "$scoped/gate-shared.json" ]] || fail 'second flow gate answer was not scoped'

BRIDGE_FLOW_ID="$first" flow steer claude 'first flow only'
equal "$(BRIDGE_FLOW_ID="$second" flow check)" ''
equal "$(BRIDGE_FLOW_ID="$first" flow check)" 'STEER=first flow only'
compgen -G "$first_control/steer-*.json.taken" > /dev/null || fail 'first flow steer receipt was not scoped'

if flow answer approve --gate '../bad' > /dev/null 2>&1; then fail 'accepted an unsafe gate id'; fi
if flow step invalid claude running title --phase NaN > /dev/null 2>&1; then fail 'accepted an invalid phase'; fi
if flow gate invalid review --wait -1 > /dev/null 2>&1; then fail 'accepted a negative wait'; fi
if flow wait missing > /dev/null 2>&1; then fail 'accepted an unknown gate'; fi
mkdir -p -- "$scratch/bad/.bridge/flow.jsonl"
if BRIDGE_WORKDIR="$scratch/bad" flow start blocked > /dev/null 2>&1; then fail 'hid an append failure'; fi
flow end --summary "$special"
assert_registry "$second" 'assert.equal(record.state, "done");'
assert_registry "$first" 'assert.equal(record.state, "live");'

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
  const firstFlow = events[1];
  assert.deepEqual(firstFlow, { t: firstFlow.t, kind: "flow", title: text, size: "large", flow: first });
  const step = find("build");
  assert.deepEqual(step, { t: step.t, flow: first, id: "build", lane: "claude", kind: "step",
    state: "running", title: text, summary: text, progress: "/looks/like/a/path", after: ["ask", "plan"], phase: 4, run: "runs/job-7" });
  assert.deepEqual(events.find(e => e.id === "build" && e.log).log, ["●", text]);
  assert.deepEqual(events.filter(e => e.id === "build" && e.meter).map(e => e.meter), [[12, null, text], [13, 20, "words"]]);
  assert.equal(find("pinned").flow, first);
  assert.equal(events[0], find("legacy"));
  assert.equal(Object.hasOwn(find("legacy"), "flow"), false);
  assert.equal(Object.hasOwn(find("pinned-empty"), "flow"), false);
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
  assert(!fs.existsSync(path.join(dir, "control", second, "gate-race.json")));
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

  assert.deepEqual(events.filter(e => e.flow === second && (e.answer === "pause" || e.answer === "resume"))
    .map(e => [e.id, e.answer, e.gate, e.text]),
    [[undefined, "pause", "paused", text], [undefined, "resume", "paused", "continue review"],
      [undefined, "pause", undefined, undefined], [undefined, "resume", undefined, undefined],
      [undefined, "pause", undefined, undefined], [undefined, "resume", undefined, undefined]]);
  assert.equal(events.find(e => e.kind === "steer" && e.to === "codex").summary, text);
  assert(events.filter(e => e.kind === "steer").every(e => e.state === "done" && e.lane === "you"));
  const receipts = events.filter(e => e.flow === second && e.log?.[1] === "steer received");
  assert.deepEqual(receipts.map(e => [e.id, e.flow, e.log[0]]), [
    ["current", second, "✓"], ["current", second, "✓"], ["current", second, "✓"], ["next", second, "✓"],
  ]);
  assert(events.indexOf(receipts[2]) < events.indexOf(find("next")), "step must check before appending");
  const control = path.join(dir, "control");
  const flat = fs.readdirSync(control);
  const scoped = fs.readdirSync(path.join(control, second));
  assert.equal(scoped.filter(name => name.endsWith(".taken")).length, 3);
  assert.deepEqual(flat.filter(name => name.endsWith(".taken")), ["steer-9-app.json.taken"]);
  assert(![...flat, ...scoped].some(name => /^steer-.*\.json$/.test(name) || name === "pause.json"));
' "$special" "$first" "$second"

make_registry_link() {
  local result
  result="$(in_node '
    const fs = require("node:fs");
    const path = require("node:path");
    const [workdir, targetName, linkName, type] = process.argv.slice(1);
    const parent = path.dirname(workdir);
    const link = path.join(parent, linkName);
    const linkType = process.platform === "win32" && type === "dir" ? "junction" : type;
    try {
      fs.symlinkSync(path.join(parent, targetName), link, linkType);
      if (!fs.lstatSync(link).isSymbolicLink()) throw new Error("Expected a filesystem link");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
      console.log("unavailable");
    }
  ' "$@")" || fail 'could not create a symlink fixture'
  [[ "$result" != unavailable ]]
}

expect_registry_warning() {
  local registry="$1"
  shift
  local error="$scratch/registry-error"
  BRIDGE_REGISTRY_DIR="$registry" flow "$@" > "$output" 2> "$error" ||
    fail "registry link caused a command failure: $(cat -- "$error")"
  grep -qi registry "$error" && grep -qi link "$error" ||
    fail "missing registry link warning: $(cat -- "$error")"
  equal "$(awk 'END { print NR }' "$error")" 1
}

mkdir -- "$scratch/dir-registry-target" "$scratch/file-registry" "$scratch/link-work"
if make_registry_link dir-registry-target dir-registry-link dir; then
  BRIDGE_WORKDIR="$scratch/link-work" expect_registry_warning "$scratch/dir-registry-link" start 'linked registry'
  linked_start="$(cat -- "$output")"
  [[ "$linked_start" == FLOW=f* ]] || fail "linked registry suppressed start output: $linked_start"
  [[ -z "$(ls -A -- "$scratch/dir-registry-target")" ]] || fail 'start wrote through the registry directory link'
  grep -Fq 'linked registry' "$scratch/link-work/.bridge/flow.jsonl" || fail 'registry link suppressed the event'
else
  printf '%s\n' 'SKIP: registry directory symlinks unavailable'
fi

cp -- "$BRIDGE_REGISTRY_DIR/$first.json" "$scratch/file-registry-target"
if make_registry_link file-registry-target "file-registry/$first.json" file; then
  BRIDGE_FLOW_ID="$first" expect_registry_warning "$scratch/file-registry" step link-file codex done 'linked record'
  cmp -s -- "$BRIDGE_REGISTRY_DIR/$first.json" "$scratch/file-registry-target" ||
    fail 'step wrote through the registry file link'
else
  printf '%s\n' 'SKIP: registry file symlinks unavailable'
fi

if make_registry_link 'work with spaces/custom-workflow.json' 'work with spaces/linked-workflow.json' file; then
  assert_steps medium "$native_workdir/linked-workflow.json" "$default_medium"
  grep -iq symlink "$steps_error" || fail "missing symlink refusal: $(cat -- "$steps_error")"
else
  printf '%s\n' 'SKIP: workflow file symlinks unavailable'
fi
if make_registry_link 'work with spaces' linked-workflow-dir dir; then
  assert_steps medium "${native_workdir%/*}/linked-workflow-dir/custom-workflow.json" "$default_medium"
  grep -iq symlink "$steps_error" || fail "missing directory symlink refusal: $(cat -- "$steps_error")"
else
  printf '%s\n' 'SKIP: workflow directory symlinks unavailable'
fi

printf '%s\n' 'flow.sh tests passed'
