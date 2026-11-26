# Integrating a UI with Trio

Trio v1.1 exposes its existing shell workflow and task artifacts as a local interface. A UI can own the presentation, process scheduling and user interaction while Claude Code or another authorized controller owns the decisions and orchestration in the skill. The same project and task directory are the source of truth.

## Interface

Run scripts with the project as the working directory and use the installed skill's absolute scripts directory. Pass arguments as arrays to a process launcher (no shell interpolation). Preserve stdout, stderr and exit status, and run long calls asynchronously in the UI.

| Action | Command |
|---|---|
| Check environment | `doctor.sh` |
| Start a task | `init_task.sh <slug>` (stdout is its absolute directory) |
| Resume a task | `init_task.sh --resume <task-id>` |
| List tasks | `task_status.py` |
| Inspect task | `task_status.py <task-id>` |
| Read project setting | `cfg.sh <key> [default]` |
| Prepare prompt | `fill_prompt.py <template> <output> KEY=value ...` |
| Gemini advisor | `ask_gemini.sh <prompt> <output>` |
| Contract-only test author | `ask_gemini.sh <prompt> <output> --contract-only` |
| Codex build | `dispatch_codex.sh <ticket> <task-directory>` |
| Codex review | `codex_review.sh <base-ref> <prompt> <output>` |

Each task is under `.multimodel/tasks/<task-id>/`. The UI can poll `task_status.py`. For a different project, use `task_status.py --repo <project-root> [task-id]`. The output is JSON with `schema_version: 1` and either `tasks` (list of IDs and paths) or `task` (ID, path, phase IDs and artifacts). Artifact paths are relative to the task directory. Each artifact has `present` and `bytes` and, for model runs with a recorded state, `run`.

Model calls write an atomic `<output>.run.json` alongside their canonical output. Codex builds use `05-receipt-codex.md`. The run record contains `schema_version`, `state` (`running`, `succeeded`, `failed`), `exit_code` (null while running) and `updated_at` (UTC). Old tasks can lack records. If the controller is killed without a chance to clean up, a record may remain running; check the process before recovering a lock. Failed preflight checks may exit before creating a record, so always retain the subprocess exit code.

Retries preserve per-attempt diagnostics in hidden directories alongside the artifact. Once a run starts, prior canonical output is archived. Successful model runs publish the new answer at the existing canonical path. Keep hidden directories private; prompts, logs and model outputs can contain project data.

## Phase mapping and approvals

The phase IDs in JSON map to the workflow: request, understand, plan, synthesis, design, build, verify, review. The actual workflow order and decisions are defined in `SKILL.md`. Some artifacts (screenshots, a scout, review rounds) may be optional. Presence is a display signal only, not completion or approval. A UI must keep explicit user approval of the synthesized plan before implementation, and apply the existing merge/deploy configuration and review/CI gates. Do not infer approval from a Markdown file, an exit code, or a model's suggested action.

Use one controller per task. Parallel Gemini and Codex calls may write different artifacts; each individual model-output path and Codex worktree has a lock. Before removing an abandoned lock, confirm its process has ended. Never automatically discard partial work or reset a worktree. Existing v1.0 worktrees at the old location can be inspected and removed with Git after their work is integrated. The new dispatcher will refuse a branch already checked out elsewhere.

For a future UI pull request, map its screens and events to this interface. Keep the skill and scripts as the shared implementation so both entry points apply the same safety and approval rules. No particular frontend framework or local web server is required by this contract.
