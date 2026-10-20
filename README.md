# claude-codex-bridge

A Claude Code plugin that lets Claude hand routine work to OpenAI Codex, so your ChatGPT plan does the token-heavy work and your Claude usage goes further, without lowering quality.

```
Claude (plans, routes, checks the result)
  └─> Codex CLI (GPT model on your ChatGPT plan)
```

It has three parts:

- **A skill** that tells Claude what to hand off (edits, tests, code reading, reviews), what to keep (hard problems, design taste, anything that publishes or touches secrets), how to brief Codex, and to check every result before showing it to you.
- **A job script** (`skills/codex-bridge/pyr.sh`) that runs one Codex job and gives Claude only Codex's final answer, not the long log.
- **A Codex card** above the message box. Collapsed it is one line (`▸ Codex · idle`, or `1 running`). Click it to see recent tasks; click a task to see the brief Claude sent and Codex's reply. You get a pop-up when a task finishes. `/codex` toggles the card.

## Requirements

- Claude Code (terminal or desktop app).
- The Codex CLI, signed in with your ChatGPT account:

  ```bash
  npm install -g @openai/codex
  codex login
  ```

  On Windows, if the Codex desktop app is installed, the script uses the Codex CLI bundled with it, which is often newer than an old npm install.
- `bash`. On Windows that is Git Bash, which Claude Code already uses.

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

By default jobs run on `gpt-6.1-sol` at `xhigh` reasoning effort. To use another model your plan has, set these in the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CODEX_BRIDGE_MODEL": "gpt-6.1-sol",
    "CODEX_BRIDGE_EFFORT": "xhigh"
  }
}
```

`CODEX_BIN` points the script at a specific `codex` executable.

## How a job runs

1. Claude writes a short brief: a title line, the goal, the files involved, what not to touch, the checks to run, and the reply format.
2. `pyr.sh <workdir> <brief-file> [read-only|workspace-write]` runs `codex exec` in that folder with that sandbox. It never uses full access.
3. The run is saved in the plugin's `runs/` folder (brief, log, reply, status), which is what the card reads.
4. Claude reads the reply, checks the diff and runs the checks itself. If the work is wrong it sends one correction, then finishes the job itself.

## License

MIT
