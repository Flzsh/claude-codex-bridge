---
name: codex-bridge
description: Hand routine coding and review work to OpenAI Codex (GPT models on the user's ChatGPT plan), and get an independent second plan or an interaction/copy review from Gemini (Antigravity CLI). Use for bounded implementation, tests, reading many files and diff reviews, and before a decision that deserves a second opinion.
---

# Codex bridge

Claude sits on top and spends its tokens on judgment: understanding the request, deciding what to hand off, writing the brief, checking the result and talking to the user. Codex, running on the user's ChatGPT plan, does the work that burns tokens: reading many files, writing code, running tests.

```
Claude (plan, route, verify, writes the frontend)
  ├─> Codex CLI (GPT model, default gpt-6.1-sol at high): bounded blocks, diff reviews
  └─> Gemini via Antigravity CLI (optional): second plan, interaction and copy review
```

Quality comes first: saving Claude tokens is only worth it when the result is as good as Claude doing it.

## Running a job

1. Write the brief to a file in your scratchpad (or a temp folder).
2. Run it with the script in this skill's base directory. Jobs over a minute or two go in the background (`run_in_background`):

```bash
bash "<this skill's base directory>/pyr.sh" <workdir> <brief-file> [read-only|workspace-write]
```

On Windows this needs Git Bash, which Claude Code's Bash tool already uses.

It prints one status line and Codex's final answer, nothing else. The full log is in the run folder it names; read it only when the job failed and the printed tail is not enough. Each run also shows on the Codex card above the message box, where the user can expand it to see the brief and the reply. The first line of the brief is the job's title on that card, so make it a short plain summary.

Model and effort: `CODEX_BRIDGE_MODEL` (default `gpt-6.1-sol`) and `CODEX_BRIDGE_EFFORT` (default `high`, kind to a ChatGPT Plus quota), read from the environment. If a job fails with a proxy hint, the user's `~/.codex/config.toml` routes Codex through a local proxy; tell them to set `CODEX_BRIDGE_BASE_URL` to `https://chatgpt.com/backend-api/codex` in the `env` block of `~/.claude/settings.json`, and don't retry on your own. If Codex rejects the model ("not supported"), tell the user and suggest a model their plan has (`codex` lists them), set via the `env` block of `~/.claude/settings.json`.

## Gemini (optional)

If the user has Antigravity CLI (`agy`, signed in with their Google account), run a Gemini job the same way:

```bash
bash "<this skill's base directory>/agy.sh" <workdir> <brief-file>
```

It prints one status line and Gemini's reply, and the run shows on the same card. Gemini answers in text only: it can read files, but edits and commands are denied in headless mode and the script never bypasses that. Put the diff or the key files into the brief; a long brief is handed over as a file automatically. Use it for two things only: an independent plan, and a review of interaction and copy. Model and effort: `AGY_MODEL` and `AGY_EFFORT` (optional; unset means Antigravity's defaults). If `agy` or `node` is missing, skip Gemini and say so; don't install them unasked. If `agy` is not signed in, tell the user to run `agy` once to sign in, and carry on without Gemini.

## The workflow

For a change worth planning (a feature, not a one-line fix):

1. **Two plans, written apart.** Write your plan to a file first. Then send Gemini the request and the relevant files, without your plan, and ask for its own.
2. **Merge item by item.** One table: each item, whose it was, adopted or rejected, and why. Present it to the user; they decide. Don't build before they do, unless they asked for the whole run.
3. **Interface and checks before any handoff.** A Codex brief names the files it may touch, the exact behaviour, and the checks it must run.
4. **Build.** Codex takes bounded backend blocks; you write the frontend and anything that needs taste. Never two writers on the same files.
5. **Review.** Gemini reviews the interaction and copy; you judge each note, apply what fits and tell the user what you changed. Never apply its notes unread or pass them on raw. Codex reviews the diff (`read-only`), at most two rounds.
6. **Check it yourself,** then stop before commit, push or publish: the user says yes to each.

## What to hand off

| Hand to Codex | Keep for Claude |
|---|---|
| Edits, fixes and features across a few files | Hard work: tricky debugging, architecture, subtle correctness, anything where a wrong answer is costly or hard to check |
| Tests for clear behaviour | Small jobs of about three tool calls or fewer: delegating costs more than doing |
| Reading and summarising code | Anything that needs back-and-forth with the user or their taste (design, art, wording) |
| Reviews of a diff (`read-only`) | Publishing, uploading, sending, committing, pushing: Codex prepares, Claude and the user decide |
| | Secrets, credentials, account settings |

Claude can still hand off the easy, separable parts of a hard job.

## Writing the brief

Short but complete. Codex starts with no context, so include:

- First line: a short title (it is shown on the card).
- Goal in one or two sentences, and why.
- Files and folders involved, and anything it must not touch.
- Constraints: style to match, no new dependencies, no commits, no pushes.
- Acceptance checks: the exact commands to run or behaviour to confirm.
- Reply format: "Reply in at most 15 lines: what you changed, files touched, checks run and their results, anything unfinished or uncertain."

## Verifying (keeps quality)

Never pass Codex output to the user unchecked.

- `git diff --stat`, then read the changed hunks that matter.
- Run the acceptance checks yourself; they are cheap compared to doing the work.
- For anything that will be published or shipped, also run a review job (`read-only`, brief: "Review the uncommitted diff for bugs...") and judge each finding before acting on it.
- If the result is wrong, send one corrective brief with the concrete failure. If it fails again, the task was harder than it looked: do it yourself.

## Rules

- Sandbox: `read-only` for research and review, `workspace-write` for edits. Never danger-full-access.
- Don't run two jobs that edit the same files at once.
- If `codex` is missing or not signed in, tell the user: `npm install -g @openai/codex`, then `codex login` with their ChatGPT account.
