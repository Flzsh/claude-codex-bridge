# Contributing

Ideas, bug reports and pull requests are welcome.

- **Bug reports:** include the output of `scripts/doctor.sh`, your OS, and the versions of `agy`, `codex` and Claude Code. Remove anything private first.
- **Workflow changes:** most behaviour lives in `plugins/trio-claude-gemini-codex/skills/trio-claude-gemini-codex/SKILL.md` and the prompt templates in `prompts/`. Explain what went wrong in a real run and how the change fixes it. Changes backed by a real run are easiest to accept.
- **Scripts:** keep them dependency-free (bash, Python 3 standard library, Node built-ins) and test them on macOS. Linux reports are very welcome.
- **CLI changes:** Gemini, Codex and their CLIs change often. If a flag or sign-in flow changed, a PR that updates the script *and* the README's troubleshooting section is ideal.

By contributing you agree your contribution is licensed under the MIT License.
