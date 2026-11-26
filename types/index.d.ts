export type JobState = 'running' | 'done' | 'failed' | 'lost'

export type Provider = 'codex' | 'gemini'

export type Job = {
  id: string
  /** Who ran it: Codex (pyr.sh) or Gemini (agy.sh). Runs from 0.1.0 have no provider and are Codex. */
  provider: Provider
  /** Who started it: Claude (through the skill or the console in Claude) or the Bridge app. */
  origin: 'claude' | 'app'
  model: string
  effort: string
  title: string
  workdir: string
  state: JobState
  exit: number | null
  /** Seconds the job ran, or has been running. */
  seconds: number
  /** Seconds since it ended; null while running. */
  endedAgo: number | null
}

export type ConsoleMode = 'read-only' | 'workspace-write'

/** One line of the console's transcript. */
export type Entry =
  | { id: number; kind: 'you'; provider: Provider; text: string }
  | { id: number; kind: 'reply'; provider: Provider; label: string; text: string; isFailed: boolean }
  | { id: number; kind: 'note'; text: string }

/** One entry of the shared log, as the Project tab lists it. */
export type LogItem = { date: string; who: string; meta: string; text: string }

export type ConsoleTab = 'chat' | 'runs' | 'project'

export type ConsoleState = {
  tab: ConsoleTab
  provider: Provider
  codexModel: string
  mode: ConsoleMode
  /** The conversation each provider continues; null starts a new one. */
  sessions: Record<Provider, string | null>
  entries: Entry[]
  /** Epoch seconds the running prompt started, or null when idle. */
  runningSince: number | null
  /** Bumped on each send, so the input field is drawn fresh and empty. */
  sends: number
  /** The shared project's goal (.bridge/project.md in the working folder), or null when there is none. */
  project: string | null
  /** The Decisions bullets of project.md. */
  decisions: string[]
  /** The newest log.md entries, newest first. */
  log: LogItem[]
}

/** The Bridge pane: its picture of the workflow, and what its controls act on. */
export type SidebarState = {
  /** The app's look, which the picture is drawn in. */
  look: 'cli' | 'drawn'
  /** The picture (an SVG document), what it says in words, and its height. */
  svg: string
  alt: string
  height: number
  /** The flow shown, or null with none. */
  flow: string | null
  live: boolean
  finished: boolean
  paused: boolean
  /** The review waiting for an answer. */
  gate: { id: string; title: string; noAuto: boolean } | null
  /** Claude's own state, from this session's hooks. */
  claude: { busy: boolean; detail: string } | null
  /** Notes for Claude not yet read, and when the last one was read (epoch seconds). */
  notes: { waiting: number; readAt: number | null }
  /** What the last button or note did. */
  notice: string | null
  /** Bumped on each send, so the input is drawn fresh and empty. */
  sends: number
  /** The pane was opened this session (so a reload does not open it again). */
  opened: boolean
}

/** What was sent to Codex and what came back, for an expanded task. */
export type JobDetail = { brief: string; reply: string }

declare module 'claude-code' {
  interface PluginState {
    'codex-bridge': {
      jobs: Job[]
      hiddenIds: string[]
      expandedIds: string[]
      details: Record<string, JobDetail>
      isCardOpen: boolean
      /** The name of the shared project's current step in the session's folder, for the band. */
      stage: string | null
      /** Effort picked on the card per provider; null = the script's default. */
      efforts: Record<Provider, string | null>
      /** The console pane: who answers, settings, conversations and transcript. */
      console: Shaped<ConsoleState>
      /** The Bridge pane. */
      sidebar: Shaped<SidebarState>
    }
  }
}
