#!/usr/bin/env python3
"""Record Trio progress and manage revision-bound workflow gates."""

import argparse
import fcntl
import json
from pathlib import Path
import sys
import time
import uuid


GATE_PHASES = {"plan": 3, "push": 7, "merge": 8, "deploy": 8}
PLAN_WAIT_MS = 30_000
DECISIONS = {"approve": "approved", "hold": "held", "decline": "declined"}


def append_event(log, event):
    log.write(json.dumps(event, separators=(",", ":")) + "\n")
    log.flush()
    return event


def latest_gate(log, gate):
    log.seek(0)
    current = None
    for line in log:
        event = json.loads(line)
        if event["type"] == "gate" and event["gate"] == gate:
            current = event
    return current


def expire_plan(log, event, now):
    deadline = event["deadline_ms"]
    if event["gate"] == "plan" and event["status"] == "waiting" and deadline is not None and now >= deadline:
        return append_event(log, dict(event, timestamp_ms=now, agent="workflow", status="continued_after_timeout"))
    return event


def apply_command(log, args, base):
    now = base["timestamp_ms"]
    if args.command == "emit":
        event = dict(base, type="phase", phase=args.phase, agent=args.agent, status=args.status)
        return append_event(log, event), 0

    current = latest_gate(log, args.gate)
    if args.command == "open":
        if current and current["revision"] == args.revision:
            return expire_plan(log, current, now), 0
        event = dict(
            base,
            type="gate",
            phase=GATE_PHASES[args.gate],
            agent="claude",
            status="waiting",
            gate=args.gate,
            gate_id=uuid.uuid4().hex,
            revision=args.revision,
            deadline_ms=now + PLAN_WAIT_MS if args.timed else None,
        )
        return append_event(log, event), 0

    if current is None:
        raise ValueError(f"no {args.gate} gate exists")

    if args.command == "resolve":
        if current["gate_id"] != args.gate_id:
            raise ValueError(f"this {args.gate} gate has been superseded")
        current = expire_plan(log, current, now)
        status = DECISIONS[args.decision]
        if current["status"] == status:
            return current, 0
        if current["status"] not in ("waiting", "held"):
            raise ValueError(f"this {args.gate} gate is already {current['status']}")
        event = dict(current, timestamp_ms=now, agent="user", status=status, deadline_ms=None)
        return append_event(log, event), 0

    current = expire_plan(log, current, now)
    if args.command == "status":
        return current, 0

    can_proceed = current["status"] == "approved" or (
        args.gate == "plan" and current["status"] == "continued_after_timeout"
    )
    return current, 0 if can_proceed and current["revision"] == args.revision else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("open", "status", "resolve", "check", "emit"):
        sub = commands.add_parser(command)
        sub.add_argument("task_dir", type=Path)
        if command == "emit":
            sub.add_argument("phase", type=int, choices=range(9))
            sub.add_argument("agent", choices=("claude", "gemini", "codex"))
            sub.add_argument("status", choices=("running", "succeeded", "failed", "skipped", "degraded"))
            continue
        sub.add_argument("gate", choices=GATE_PHASES)
        if command in ("open", "check"):
            sub.add_argument("revision")
        if command == "open":
            sub.add_argument("--timed", action="store_true", help="allow the plan to proceed after 30 seconds")
        if command == "resolve":
            sub.add_argument("gate_id")
            sub.add_argument("decision", choices=DECISIONS)

    args = parser.parse_args(argv)
    if args.command == "open" and args.timed and args.gate != "plan":
        parser.error("only the plan gate supports a deadline")
    task_dir = args.task_dir.resolve()
    try:
        with (task_dir / "events.jsonl").open("a+", encoding="utf-8") as log:
            # Read, decide, and append under one lock so a timeout and a click cannot both win.
            fcntl.flock(log, fcntl.LOCK_EX)
            base = {
                "schema_version": 1,
                "run_id": task_dir.name,
                "timestamp_ms": time.time_ns() // 1_000_000,
            }
            event, code = apply_command(log, args, base)
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(event))
    return code


if __name__ == "__main__":
    sys.exit(main())
