// The contract between the app's window (Claude builds it) and its Node side
// (Codex builds it). Every function here is implemented in the file named on
// it, runs in Electron's main process, and is exposed to the window through
// preload.ts. The formats are the plugin's own: runs/<id>/status.json,
// settings.json, .bridge/project.md and log.md.

import type { Job, LogItem, Provider } from '../../../types'
import type { Efforts } from '../../../core/jobs'

export type Mode = 'read-only' | 'workspace-write'

// ---------------------------------------------------------------- paths.ts

export type Paths = {
  /** The plugin's folder (the parent of app/). */
  pluginRoot: string
  /** <plugin>/runs: one folder per job, written by pyr.sh / agy.sh. */
  runsDir: string
  /** <plugin>/settings.json: the efforts picked in the band or the app. */
  settingsFile: string
  /** <plugin>/inbox: hand-offs to Claude, read by the plugin's poll. */
  inboxDir: string
  /** <plugin>/app-briefs: one brief file per app run, removed when the run ends. */
  briefsDir: string
  /** <plugin>/skills/codex-bridge: pyr.sh and agy.sh. */
  scriptsDir: string
}

/** paths.ts: every path from the plugin's folder. */
export type PluginPaths = (pluginRoot: string) => Paths

// ----------------------------------------------------------------- bash.ts

export type BashLookup = {
  env: Record<string, string | undefined>
  platform: string
  exists: (path: string) => boolean
  /** The first match on PATH for a command, or null. */
  which: (command: string) => string | null
}

/**
 * bash.ts: the bash that runs pyr.sh / agy.sh. On Windows, in order:
 * BRIDGE_BASH, CLAUDE_CODE_GIT_BASH_PATH, C:/Program Files/Git/bin/bash.exe,
 * C:/Program Files (x86)/Git/bin/bash.exe, then Git's own bash beside git.exe
 * on PATH (<git>/cmd/git.exe -> <git>/bin/bash.exe). Never C:/Windows/System32/bash.exe
 * (WSL). Elsewhere: BRIDGE_BASH, then bash on PATH. A candidate counts only if it exists.
 */
export type FindBash = (lookup: BashLookup) => { path: string } | { error: string }

// --------------------------------------------------------------- threads.ts

/** One conversation per provider in the app's console. */
export type Thread = {
  /** The conversation to continue, or null to start a new one. */
  session: string | null
  /** Bumped by New; a reply from an older generation never restores its session. */
  generation: number
  /** The run holding this thread, or null when idle. */
  runningId: string | null
}

export type Threads = Record<Provider, Thread>

/** threads.ts (pure). Reserve the thread for a run; null when it is busy. */
export type Reserve = (threads: Threads, provider: Provider, runId: string) => Threads | null
/** threads.ts (pure). Free the thread; keep `session` only if `generationAtStart` is still current. */
export type Finish = (
  threads: Threads,
  provider: Provider,
  runId: string,
  generationAtStart: number,
  session: string | null,
) => Threads
/** threads.ts (pure). New: generation + 1, session null; a running run keeps its slot. */
export type Reset = (threads: Threads, provider: Provider) => Threads

// ---------------------------------------------------------------- runner.ts

export type RunRequest = {
  provider: Provider
  prompt: string
  /** The folder the agent works in (the project folder). */
  workdir: string
  /** Codex only: the model (CODEX_BRIDGE_MODEL). Gemini ignores it. */
  model?: string
  /** Codex only: read-only or workspace-write. */
  mode: Mode
  /** The conversation to continue (CODEX_BRIDGE_RESUME / AGY_CONVERSATION), or null. */
  session: string | null
  /** BRIDGE_* variables that put the run in the flow (BRIDGE_STEP, BRIDGE_STEP_TITLE, BRIDGE_FLOW_ID, BRIDGE_WORKDIR). */
  env?: Record<string, string>
}

export type RunResult = {
  /** Exit 0 and a reply. */
  ok: boolean
  /** Ended by stop(). */
  stopped: boolean
  exitCode: number | null
  model: string
  effort: string
  seconds: number | null
  /** From the status line's session=…; null when none. */
  session: string | null
  /** The reply: everything after the status line on stdout. */
  reply: string
  /** stderr, kept apart from stdout (last 4000 characters). */
  stderr: string
}

export type RunHandle = {
  id: string
  done: Promise<RunResult>
  /** Ends the whole process tree (bash, codex/agy and their children) and resolves once it has exited. */
  stop: () => Promise<void>
}

export type RunnerDeps = {
  paths: Paths
  /** From findBash. */
  bash: string
}

/**
 * runner.ts: starts one run. Writes the prompt to its own brief file in
 * paths.briefsDir (unique name, via consoleBrief from core/console), spawns
 * `bash <scriptsDir>/pyr.sh|agy.sh <workdir> <brief> <mode>` with the env
 * above (never shell: true; windowsHide; detached on POSIX so the group can be
 * killed), reads stdout and stderr separately, parses stdout with
 * parseRunOutput from core/console, deletes the brief when the run ends.
 * stop(): Windows `taskkill /PID <pid> /T /F`; POSIX SIGTERM to the group,
 * SIGKILL after 3 s.
 */
export type StartRun = (request: RunRequest, deps: RunnerDeps) => RunHandle

// ----------------------------------------------------------------- store.ts

export type ProjectView = {
  exists: boolean
  goal: string | null
  stage: string | null
  /** How much workflow: small, medium or large (large when unset). */
  size: 'small' | 'medium' | 'large'
  decisions: string[]
  questions: string[]
  /** Newest first, at most 40. */
  log: LogItem[]
}

/** store.ts: reads <workdir>/.bridge/project.md and log.md (missing files are fine). */
export type ReadProject = (workdir: string) => Promise<ProjectView>
/** store.ts: creates .bridge/project.md (projectTemplate) with an exclusive create, and log.md if missing. */
export type StartProject = (workdir: string, goal: string, date: string, size?: 'small' | 'medium' | 'large') => Promise<'created' | 'exists'>
/** store.ts: sets ## Stage in project.md (withStage); throws if there is no project. */
export type SetStage = (workdir: string, stageId: string) => Promise<void>
/** store.ts: appends one entry (logEntry) to log.md with fs.appendFile; never rewrites it. */
export type AppendLog = (workdir: string, who: string, text: string, date: string) => Promise<void>

/** store.ts: the saved efforts (parseEfforts); defaults when missing. */
export type ReadEfforts = (paths: Paths) => Promise<Efforts>
/** store.ts: re-reads settings.json, sets one provider, writes a temp file and renames it over. */
export type WriteEffort = (paths: Paths, provider: Provider, effort: string | null) => Promise<Efforts>

/** store.ts: the newest `limit` runs as Jobs (toJob), newest first. */
export type ListRuns = (paths: Paths, nowSeconds: number, limit: number) => Promise<Job[]>
/** store.ts: one run's brief, reply and, when it failed, the last log lines (clip / logTail). */
export type ReadRun = (paths: Paths, id: string) => Promise<{ brief: string; reply: string; logTail: string }>

export type Handoff = {
  /** The folder of the Claude session it is for. */
  cwd: string
  /** fill = put in Claude's prompt box; send = submit it as a prompt. */
  mode: 'fill' | 'send'
  text: string
}

/** store.ts: writes <inbox>/<time>-<rand>.json atomically (temp file, then rename); returns its path. */
export type WriteHandoff = (paths: Paths, handoff: Handoff) => Promise<string>
