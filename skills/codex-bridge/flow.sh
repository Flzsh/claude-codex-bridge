#!/usr/bin/env bash
# Write Bridge workflow events and wait for answers from the desktop or CLI.
set -u

workdir="${BRIDGE_WORKDIR:-$PWD}"
if command -v cygpath >/dev/null 2>&1; then
  workdir="$(cygpath -am -- "$workdir")" || exit
fi

# Convert only the workdir. Git Bash must pass event text and run IDs verbatim.
MSYS2_ARG_CONV_EXCL='*' exec node -e '
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { setTimeout: sleep } = require("node:timers/promises");

const [workdir, command, ...args] = process.argv.slice(1);
const bridge = path.join(workdir, ".bridge");
const control = path.join(bridge, "control");
const eventFile = path.join(bridge, "flow.jsonl");
const currentFile = path.join(bridge, "flow-current");
const pauseFile = path.join(control, "pause.json");
const gateFile = id => path.join(control, `gate-${id}.json`);
const now = () => Date.now() / 1000;
const lanes = ["you", "claude", "gemini", "codex"];
const states = ["running", "done", "failed", "waiting"];
const answers = ["approve", "decline", "steer"];
const stepOptions = ["--summary", "--after", "--phase"];
const defaultWait = 30;
const defaultMax = 540;
const defaultDoneTitle = "approved the plan";
const isTerminal = state => state === "done" || state === "failed";

class UsageError extends Error {}

function choose(value, choices, label) {
  if (!choices.includes(value)) throw new UsageError(`${label} must be one of ${choices.join(", ")}`);
  return value;
}

function safeId(value) {
  if (value === undefined || !/^[\w.-]{1,80}$/.test(value) || value.startsWith(".")) {
    throw new UsageError("id must be 1–80 letters, digits, underscores, dashes or dots and cannot start with a dot");
  }
  return value;
}

function number(value, label, minimum = -Infinity) {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < minimum) {
    throw new UsageError(`${label} must be a ${minimum === 0 ? "nonnegative " : ""}finite number`);
  }
  return n;
}

function options(rest, allowed) {
  const parsed = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!allowed.includes(flag) || Object.hasOwn(parsed, flag)) throw new UsageError(`invalid option: ${flag}`);
    const value = flag === "--no-auto" ? true : rest[++i];
    if (value === undefined) throw new UsageError(`${flag} requires a value`);
    parsed[flag] = value;
  }
  return parsed;
}

function eventDetails(opts) {
  const after = opts["--after"];
  const phase = opts["--phase"];
  return {
    summary: opts["--summary"],
    after: after === "" ? [] : after?.split(",").map(id => safeId(id.trim())),
    phase: phase === undefined ? undefined : number(phase, "phase"),
  };
}

function requireArgs(count, usage, extra = false) {
  if (args.length < count || (!extra && args.length !== count)) throw new UsageError(`usage: flow.sh ${usage}`);
}

function parseEvent() {
  switch (command) {
    case "start": {
      requireArgs(1, "start <title> [--size <size>]", true);
      const [title, ...rest] = args;
      const size = options(rest, ["--size"])["--size"];
      if (size !== undefined) choose(size, ["small", "medium", "large"], "size");
      return { kind: "flow", title, size };
    }
    case "end":
      return { kind: "flow", state: "done", summary: options(args, ["--summary"])["--summary"] };
    case "step": {
      requireArgs(4, "step <id> <lane> <state> <title> [options]", true);
      const [id, lane, state, title, ...rest] = args;
      const opts = options(rest, [...stepOptions, "--progress", "--run"]);
      return {
        id: safeId(id), lane: choose(lane, lanes, "lane"), state: choose(state, states, "state"),
        kind: "step", title, ...eventDetails(opts), progress: opts["--progress"], run: opts["--run"],
      };
    }
    case "say": {
      requireArgs(3, "say <id> <mark> <text>");
      const [id, mark, text] = args;
      // > brief, ● action, ⎿ result, ✻ thinking, ✓ done; for the plan in a review: # a point (text|C G), h a heading, ? a choice (A|question), … a quiet line
      return { id: safeId(id), log: [choose(mark, [">", "●", "⎿", "✻", "✓", "#", "h", "?", "…"], "mark"), text] };
    }
    case "meter": {
      requireArgs(4, "meter <id> <n> <total-or-dash> <unit>");
      const [id, n, total, unit] = args;
      return { id: safeId(id), meter: [number(n, "n"), total === "-" ? null : number(total, "total"), unit] };
    }
    case "steer": {
      requireArgs(2, "steer <claude|gemini|codex> <text>");
      const [to, text] = args;
      choose(to, lanes.slice(1), "recipient");
      return { id: `steer-${nonce()}`, lane: "you", state: "done", kind: "steer", to, title: `steered ${to}`, summary: text };
    }
    case "gate": {
      requireArgs(2, "gate <id> <title> [options]", true);
      const [id, title, ...rest] = args;
      const opts = options(rest, [...stepOptions, "--wait", "--no-auto", "--max", "--done-title"]);
      return {
        id: safeId(id), title, lane: "you", kind: "gate", state: "waiting", ...eventDetails(opts),
        wait: number(opts["--wait"] ?? String(defaultWait), "wait", 0),
        noAuto: opts["--no-auto"] === true,
        max: number(opts["--max"] ?? String(defaultMax), "max", 0),
        doneTitle: opts["--done-title"],
      };
    }
    case "wait":
      requireArgs(1, "wait <id>");
      return { id: safeId(args[0]) };
    case "check":
      requireArgs(0, "check");
      return {};
    case "answer": {
      const [answer, ...rest] = args;
      choose(answer, [...answers, "pause", "resume"], "answer");
      const opts = options(rest, ["--gate", "--text"]);
      const gate = opts["--gate"];
      return { answer, gate: gate === undefined && !answers.includes(answer) ? undefined : safeId(gate), text: opts["--text"] };
    }
    default:
      throw new UsageError("usage: flow.sh <start|end|step|say|meter|steer|check|gate|wait|answer> [args]");
  }
}

function nonce() {
  return Date.now().toString(36) + "-" + randomBytes(6).toString("hex");
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
}

// A link planted in a cloned project must not redirect writes outside it.
function refuseLink(file) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (info?.isSymbolicLink()) throw new Error(`${file} is a link; flow.sh does not write through links`);
}

function append(flow, event, t = now()) {
  refuseLink(bridge);
  refuseLink(eventFile);
  fs.appendFileSync(eventFile, JSON.stringify({ t, flow, ...event }) + "\n", "utf8");
}

function readEvents() {
  return (readText(eventFile) ?? "").split("\n").map(parseJson).filter(event => Number.isFinite(event?.t));
}

function writeExclusive(file, data) {
  refuseLink(control);
  try { fs.writeFileSync(file, JSON.stringify(data), { flag: "wx" }); }
  catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  return true;
}

function start(event) {
  const flow = `f${nonce()}`;
  // A long-lived project keeps the live file small: past flows move to flow-<time>.jsonl.
  const size = fs.statSync(eventFile, { throwIfNoEntry: false })?.size ?? 0;
  if (size > 2 * 1024 * 1024) {
    refuseLink(eventFile);
    fs.renameSync(eventFile, path.join(bridge, `flow-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));
  }
  append(flow, event);
  const temporary = `${currentFile}.${flow}.tmp`;
  try {
    fs.writeFileSync(temporary, `${flow}\n`);
    fs.renameSync(temporary, currentFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  console.log(`FLOW=${flow}`);
}

function isPaused() {
  return fs.statSync(pauseFile, { throwIfNoEntry: false }) !== undefined;
}

function newestRunningClaude(flow) {
  const steps = new Map();
  const events = readEvents().filter(event => (event.flow || undefined) === flow && event.id);
  events.sort((a, b) => a.t - b.t);
  for (const event of events) {
    let step = steps.get(event.id);
    if (!step) {
      step = { id: event.id };
      steps.set(event.id, step);
    }
    if (event.lane !== undefined) step.lane = event.lane;
    if (event.kind !== undefined) step.kind = event.kind;
    if (event.state !== undefined && event.state !== step.state) {
      step.state = event.state;
      step.since = event.t;
    }
  }
  let newest;
  for (const step of steps.values()) {
    if (step.lane === "claude" && step.state === "running" && (step.kind === "step" || !step.kind) &&
        (!newest || step.since >= newest.since)) newest = step;
  }
  return newest?.id;
}

async function check(flow, takeSteers = true) {
  if (isPaused()) {
    console.log("PAUSED=1");
    const until = now() + defaultMax;
    while (isPaused()) {
      if (now() >= until) {
        console.log("PAUSED=still");
        return false;
      }
      await sleep(1000);
    }
  }

  // Steers are for Claude: a Codex or Gemini step waits out a pause but leaves them where they are.
  if (!takeSteers) return true;
  // The desktop and CLI put the creation timestamp in the filename.
  const steers = (fs.existsSync(control) ? fs.readdirSync(control) : []).filter(name => /^steer-.+\.json$/.test(name));
  steers.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  let step;
  let haveRecipient = false;
  for (const name of steers) {
    const file = path.join(control, name);
    const steer = parseJson(readText(file));
    if (steer === undefined) continue; // Another check took it, or the writer has not finished.
    if (typeof steer?.text !== "string") throw new Error(`invalid steer in ${file}`);
    if (!haveRecipient) {
      step = newestRunningClaude(flow);
      haveRecipient = true;
    }
    try { fs.renameSync(file, `${file}.taken`); }
    catch (error) {
      if (error.code === "ENOENT") continue; // Another check won the rename.
      throw error;
    }
    if (step) append(flow, { id: step, log: ["✓", "steer received"] });
    console.log(`STEER=${steer.text}`);
  }
  return true;
}

function loadGate(flow, id) {
  const events = readEvents();
  const opens = events.filter(event => event.id === id && event.kind === "gate" && event.state === "waiting");
  const definition = opens.find(event => (event.flow || undefined) === flow);
  if (!definition) {
    // Answer filenames are shared by flows, so a gate ID belongs to one flow.
    if (opens.length) throw new UsageError(`gate ${id} belongs to a different flow`);
    return;
  }
  const gate = { wait: defaultWait, max: defaultMax, paused: false, ...definition };
  // A timed gate always has a deadline: recover it from when it opened if the record has none.
  if (!gate.noAuto && !gate.paused && gate.until === undefined) gate.until = (definition.t ?? now()) + gate.wait;
  for (const event of events) {
    if ((event.flow || undefined) !== flow) continue;
    if (event.gate === id && event.answer === "approve" && event.auto === true) gate.autoAnswer = true;
    if (event.id !== id) continue;
    if (isTerminal(event.state)) {
      // A review answered with a change is closed as "asked for changes" (answer: steer), so it stops waiting in the view.
      gate.result = event.state === "failed" ? "decline" : event.answer === "steer" ? "steer" : event.auto ? "auto" : "approve";
      if (gate.result === "steer") gate.steerText = event.summary ?? "";
    }
    if (typeof event.paused === "boolean") {
      gate.paused = event.paused;
      gate.until = event.until;
    }
  }
  return gate;
}

function openGate(flow, event) {
  const at = now();
  const paused = isPaused();
  const gate = { ...event, paused, until: paused || event.noAuto ? undefined : at + event.wait };
  append(flow, gate, at);
  return gate;
}

function readAnswer(file) {
  const result = parseJson(readText(file));
  // A writer using wx can leave an empty or partial file visible during its write.
  if (result === undefined) return;
  if (!answers.includes(result?.answer) || (result.text != null && typeof result.text !== "string")) {
    throw new Error(`invalid gate answer in ${file}`);
  }
  return result;
}

function settleGate(flow, gate, result) {
  const { id, wait, doneTitle = defaultDoneTitle } = gate;
  const { answer, auto, text } = result;
  const current = loadGate(flow, id);
  if (answer === "steer") {
    if (!current.result) append(flow, { id, state: "done", title: "asked for changes", answer: "steer", summary: text ?? "" });
    console.log(`GATE=steer\nTEXT=${text ?? ""}`);
    return;
  }
  if (current.result) {
    console.log(`GATE=${current.result}`);
    return;
  }
  if (answer === "decline") {
    append(flow, { id, state: "failed", summary: text ?? "declined by you" });
    console.log("GATE=decline");
  } else if (auto === true) {
    // A retry can finish writing the events if the process stopped after claiming wx.
    if (!current.autoAnswer) append(flow, { answer: "approve", gate: id, auto: true });
    append(flow, { id, state: "done", title: doneTitle, auto: true, summary: `nobody answered in ${wait} s, so it carried on` });
    console.log("GATE=auto");
  } else {
    append(flow, { id, state: "done", title: doneTitle, summary: "approved by you" });
    console.log("GATE=approve");
  }
}

async function waitForGate(flow, gate) {
  if (gate.result) {
    console.log(gate.result === "steer" ? `GATE=steer\nTEXT=${gate.steerText ?? ""}` : `GATE=${gate.result}`);
    return;
  }
  const file = gateFile(gate.id);
  const started = now();
  let sliceUntil = started + gate.max;
  let pausedAt = gate.paused ? started : undefined;
  for (;;) {
    const at = now();
    const paused = isPaused();
    if (paused !== gate.paused) {
      if (paused) pausedAt = at;
      else sliceUntil += at - pausedAt;
      gate.paused = paused;
      gate.until = paused || gate.noAuto ? undefined : at + gate.wait;
      append(flow, { id: gate.id, state: "waiting", paused, until: gate.until }, at);
    }

    let result = readAnswer(file);
    if (!result && !paused && !gate.noAuto && gate.until <= at && gate.until <= sliceUntil) {
      if (isPaused()) continue;
      const auto = { answer: "approve", auto: true };
      result = writeExclusive(file, auto) ? auto : readAnswer(file);
    }
    if (result) return settleGate(flow, gate, result);
    if (!paused && at >= sliceUntil) {
      console.log(`GATE=waiting\nRESUME=flow.sh wait ${gate.id}`);
      return;
    }
    await sleep(250);
  }
}

async function main() {
  const event = parseEvent();
  fs.mkdirSync(control, { recursive: true });
  if (command === "start") return start(event);

  // An explicitly empty override pins a runner to legacy, unscoped events.
  const flow = (process.env.BRIDGE_FLOW_ID ?? readText(currentFile)?.trim()) || undefined;
  switch (command) {
    case "check":
      await check(flow);
      return;
    case "step": {
      const skipCheck = isTerminal(event.state) && process.env.BRIDGE_FLOW_SKIP_CHECK === "1";
      if (skipCheck || await check(flow, event.lane === undefined || event.lane === "claude")) append(flow, event);
      return;
    }
    case "steer":
      if (event.to === "claude") {
        const file = path.join(control, `steer-${Date.now()}-${randomBytes(6).toString("hex")}.json`);
        if (!writeExclusive(file, { text: event.summary, by: "you", t: now() })) throw new Error(`steer already exists: ${file}`);
      }
      break;
    case "gate":
    case "wait": {
      const gate = loadGate(flow, event.id);
      if (!gate && command === "wait") throw new UsageError(`unknown gate: ${event.id}`);
      return waitForGate(flow, gate ?? openGate(flow, event));
    }
    case "answer":
      if (event.answer === "pause") { refuseLink(control); refuseLink(pauseFile); fs.writeFileSync(pauseFile, JSON.stringify({ t: now() })); }
      else if (event.answer === "resume") fs.rmSync(pauseFile, { force: true });
      else if (!writeExclusive(gateFile(event.gate), { answer: event.answer, text: event.text })) {
        console.log("ANSWER=taken");
        return;
      }
      break;
  }
  append(flow, event);
}

main().catch(error => {
  console.error(`flow.sh: ${error.message}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
' -- "$workdir" "$@"
