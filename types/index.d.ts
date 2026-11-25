export type JobState = 'running' | 'done' | 'failed' | 'lost'

export type Provider = 'codex' | 'gemini'

export type Job = {
  id: string
  /** Who ran it: Codex (pyr.sh) or Gemini (agy.sh). Runs from 0.1.0 have no provider and are Codex. */
  provider: Provider
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

/** What was sent to Codex and what came back, for an expanded task. */
export type JobDetail = { brief: string; reply: string }

declare module 'claude-code' {
  interface PluginState {
    'codex-bridge': {
      jobs: Job[]
      hiddenIds: string[]
      isCardOpen: boolean
      expandedIds: string[]
      details: Record<string, JobDetail>
    }
  }
}
