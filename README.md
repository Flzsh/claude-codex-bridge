# claude-codex-bridge

A Claude Code plugin that lets Claude hand routine work to OpenAI Codex, so your ChatGPT plan does the token-heavy work and your Claude usage goes further, without lowering quality. Since 0.2.0 it can also ask Gemini (through Google's Antigravity CLI) for an independent second plan and a review of interaction and copy.

```
Claude (plans, routes, checks the result, writes the frontend)
  ├─> Codex CLI (GPT model on your ChatGPT plan): bounded blocks, diff reviews
  └─> Gemini via Antigravity CLI (optional): second plan, interaction and copy review
```

## The workflow

For a feature or a change worth planning, not a one-line fix:

1. You say what you want.
2. Claude writes a plan; Gemini writes its own without seeing Claude's.
3. Claude merges them item by item, marking whose idea was adopted and why the other wasn't. You decide.
4. Claude defines the interfaces and the acceptance checks, hands self-contained backend tasks to Codex, and writes the UI and other design-sensitive code itself.
5. Gemini reviews the interaction and copy; Codex reviews the diff, at most two rounds.
6. Claude runs the checks. Nothing is committed, pushed or published without your yes.

Without Antigravity CLI, Claude writes the plan alone (so there is nothing to merge in step 3) and step 5 has only the Codex review.

## What's inside

The plugin has four parts:

- **A skill** that tells Claude what to hand off (edits, tests, code reading, reviews), what to keep (hard problems, design taste, anything that publishes or touches secrets), how to brief Codex, and to check every result before showing it to you.
- **A job script** (`skills/codex-bridge/pyr.sh`) that runs one Codex job and gives Claude only Codex's final answer, not the long log.
- **A Gemini script** (`skills/codex-bridge/agy.sh`) that runs one Gemini job through Antigravity CLI. Gemini answers in text only: it can read files but cannot edit them or run commands, and the script never bypasses Antigravity's permission checks.
- **A Codex card** above the message box. Collapsed it is one line (`▸ Codex · idle`, or `1 running`). Click it to see recent Codex and Gemini tasks; click a task to see the brief Claude sent and the reply. You get a pop-up when a task finishes. `/codex` toggles the card.

## Requirements

- Claude Code (terminal or desktop app).
- The Codex CLI, signed in with your ChatGPT account:

  ```bash
  npm install -g @openai/codex
  codex login
  ```

  On Windows, if the Codex desktop app is installed, the script uses the Codex CLI bundled with it, which is often newer than an old npm install.
- `bash`. On Windows that is Git Bash, which Claude Code already uses.
- Optional, for Gemini: [Antigravity CLI](https://antigravity.google/download), signed in once by running `agy` (a personal Google account; Google AI Pro raises its limits), and `node` on PATH to read its replies. Gemini CLI no longer serves personal accounts.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install codex-bridge --marketplace Flzsh/claude-codex-bridge
```

From a shell:

```bash
claude plugin install codex-bridge --marketplace Flzsh/claude-codex-bridge
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Flzsh/claude-codex-bridge`, then Add plugin.

Answer `y` to add the marketplace and pick the user scope. The card appears in sessions started after the install.

## Choosing the model

By default jobs run on `gpt-6.1-sol` at `high` reasoning effort, which suits a ChatGPT Plus quota. To use another model your plan has, set these in the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CODEX_BRIDGE_MODEL": "gpt-6.1-sol",
    "CODEX_BRIDGE_EFFORT": "xhigh"
  }
}
```

`CODEX_BIN` points the script at a specific `codex` executable.

If your `~/.codex/config.toml` sends Codex through a local proxy (`openai_base_url`) that refuses it, a failed job prints a hint. Set `CODEX_BRIDGE_BASE_URL` to `https://chatgpt.com/backend-api/codex` to send this plugin's jobs straight to ChatGPT; your config file is left alone.

For Gemini, set these in the same `env` block if needed: `AGY_BIN` points at a specific `agy` executable; `AGY_MODEL` and `AGY_EFFORT` override Antigravity's defaults by passing `--model` and `--effort`.

## How a job runs

1. Claude writes a short brief: a title line, the goal, the files involved, what not to touch, the checks to run, and the reply format.
2. `pyr.sh <workdir> <brief-file> [read-only|workspace-write]` runs `codex exec` in that folder with that sandbox. It never uses full access.
3. The run is saved in the plugin's `runs/` folder (brief, log, reply, status), which is what the card reads.
4. Claude reads the reply, checks the diff and runs the checks itself. If the work is wrong it sends one correction, then finishes the job itself.

## License

MIT
