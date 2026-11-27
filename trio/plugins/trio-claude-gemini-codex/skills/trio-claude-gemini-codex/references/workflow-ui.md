# Workflow UI contract

Claude drives Trio's workflow. A UI can display progress and send explicit decisions from the user through `flow.py`. Keep the existing Claude Code entry points available. Set `flow` to the absolute path of the installed skill's `scripts/flow.py` and `T` to the task directory returned by `init_task.sh`.

## Record and display progress

```bash
python3 "$flow" emit "$T" 5 codex running
python3 "$flow" emit "$T" 5 codex failed
```

Emit progress from observed work and process results. Use `running`, `succeeded`, `failed`, `skipped`, or `degraded` for each participating agent (`claude`, `gemini`, `codex`). A phase can have several workers. When the UI groups rows, use the phase IDs as the source for each row.

| ID | Trio phase | Bridge view |
| --- | --- | --- |
| 0 | Setup check | Ask |
| 1 | Understand and scout | Ask |
| 2 | Independent plans | Two plans |
| 3 | Synthesize and offer plan review | Merge plans / Decide |
| 4 | Design and review | Build prep |
| 5 | Contract, implementation, and acceptance test authoring | Build |
| 6 | Integration, test execution, and visual QA | Verify |
| 7 | User-approved push and pull request | Check and ship |
| 8 | Codex review, CI, merge, deploy, and live verification | Review / Check and ship |

`events.jsonl` in the task directory is append-only. Each record has `schema_version` (currently `1`), `run_id` (the task directory name), `timestamp_ms` (Unix milliseconds), `type` (`phase` or `gate`), `phase`, `agent`, and `status`. Gate records also have `gate`, `gate_id`, `revision`, and `deadline_ms` (Unix milliseconds or `null`). The latest record for a gate name is its current state. Replay complete lines on reconnect and keep the file local. The log contains status and identifiers. Keep briefs, replies, screenshots, and logs in the task folder, and ask before exporting selected artifacts.

## Plan gate

Show the plan and explain the countdown and hold control before opening a timed gate. Use a content hash of the displayed plan as its revision:

```bash
revision="$(git hash-object "$T/03-synthesis.md")"
python3 "$flow" open "$T" plan "$revision" --timed
python3 "$flow" status "$T" plan
python3 "$flow" resolve "$T" plan "$gate_id" hold
python3 "$flow" resolve "$T" plan "$gate_id" approve
python3 "$flow" check "$T" plan "$revision"
```

For a surface that queues replies until Claude finishes its turn, omit `--timed` and wait for the user before resolving. `open`, `status`, `resolve`, and `check` return the current record as JSON on stdout when a record is available. Use the `gate_id` from the record the user saw. The UI can poll `status` across a restart. Claude runs `check` against the current plan revision immediately before continuing.

Status starts at `waiting`. At the deadline, the next command observes `continued_after_timeout` with agent `workflow`. Label that outcome “Continued after timeout.” A user can explicitly approve, hold, or decline. A hold removes the deadline and can be resolved later. For a plan change, open a gate for the new revision. It supersedes an earlier gate of the same name. Reopening the same revision returns the existing gate and preserves its deadline or resolution.

## Push, merge, and deploy gates

Open each gate without a timer. Show the exact action and use an opaque revision that identifies what the user is approving. For a push, bind the remote, branch, and commit. For a merge, bind the PR and its head commit. For a deploy, bind the merged revision, target, and a hash of the deploy command. Keep raw commands and credentials out of the event log.

```bash
python3 "$flow" open "$T" push "$push_revision"
python3 "$flow" resolve "$T" push "$gate_id" approve
python3 "$flow" check "$T" push "$push_revision"
```

The UI calls `resolve ... approve` in response to a user action. Claude calls `check` immediately before the external action. Exit code 0 authorizes the matching revision. Exit code 1 means the current gate does not authorize it. Exit code 2 means invalid input or an unavailable gate. Recompute the revision just before the check and ask again when it changes.

## Checks for a UI PR

- Include launch instructions, dependencies, and a smoke run using [the fixture](../../../../../tests/fixtures/bridge-run.jsonl). It needs no model accounts. The fixture shows a plan timeout, a failed worker with a fallback, and a push awaiting approval.
- Show that holding the plan suspends the countdown and that a response to an old gate leaves the current revision pending.
- Show that push stays pending after the UI closes and reopens, and that it proceeds only after explicit approval of the current revision.
- Verify a terminal run through the existing skill entry point with the UI closed.
