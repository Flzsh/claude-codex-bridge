import type { Job, JobState } from '../types'

/** Where skills/codex-bridge/pyr.sh writes one folder per run: <plugin>/runs. */
export function runsDir(pluginRoot: string): string {
  return `${pluginRoot.replace(/[\\/]+$/, '')}/runs`
}

/** A finished job stays on the card this long. */
export const SHOW_FINISHED_SECONDS = 20 * 60

/** A job still "running" after this long lost its runner (killed without a trap). */
export const LOST_AFTER_SECONDS = 3 * 60 * 60

type Status = {
  model?: string
  effort?: string
  title?: string
  workdir?: string
  startedAt?: number
  state?: string
  exit?: number | null
  endedAt?: number | null
}

/** One run's status.json as a Job, or null when it is unreadable. */
export function toJob(id: string, text: string, nowSeconds: number): Job | null {
  let status: Status
  try {
    status = JSON.parse(text) as Status
  } catch {
    return null
  }
  if (typeof status.startedAt !== 'number') return null

  let state: JobState = status.state === 'done' || status.state === 'failed' ? status.state : 'running'
  const endedAt = typeof status.endedAt === 'number' ? status.endedAt : null
  if (state === 'running' && nowSeconds - status.startedAt > LOST_AFTER_SECONDS) state = 'lost'

  const isRunning = state === 'running'
  return {
    id,
    model: status.model ?? '?',
    effort: status.effort ?? '',
    title: status.title ?? '',
    workdir: status.workdir ?? '',
    state,
    exit: typeof status.exit === 'number' ? status.exit : null,
    seconds: Math.max(0, (isRunning || endedAt === null ? nowSeconds : endedAt) - status.startedAt),
    endedAgo: isRunning || endedAt === null ? null : Math.max(0, nowSeconds - endedAt),
  }
}

/** Running jobs, plus finished ones from the last SHOW_FINISHED_SECONDS. */
export function isVisible(job: Job): boolean {
  if (job.state === 'running') return true
  if (job.state === 'lost') return false
  return job.endedAgo !== null && job.endedAgo <= SHOW_FINISHED_SECONDS
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`
}

/** The model as a person names it: "gpt-6.1-sol" is "Sol 6.1"; others as given. */
export function modelName(model: string): string {
  const [, version, family] = /^gpt-([\d.]+)-(\w+)$/.exec(model) ?? []
  return version && family ? `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}` : model
}

/** Left of a job's first row: "Sol 6.1 · ultra". */
export function headline(job: Job): string {
  return `${modelName(job.model)}${job.effort ? ` · ${job.effort}` : ''}`
}

/** Right of a job's first row: where it stands and for how long. */
export function timing(job: Job): string {
  switch (job.state) {
    case 'running':
      return `running ${duration(job.seconds)}`
    case 'done':
      return `done in ${duration(job.seconds)} · ${duration(job.endedAgo ?? 0)} ago`
    case 'failed':
      return `failed${job.exit === null ? '' : ` (exit ${job.exit})`} after ${duration(job.seconds)}`
    case 'lost':
      return 'lost'
  }
}

/** A job's second row: what it was asked, and in which folder. */
export function detail(job: Job): string {
  return [job.title, job.workdir].filter(Boolean).join(' · ')
}

/** Long texts are cut to this many characters on the card. */
export const DETAIL_CHARS = 6000

export function clip(text: string, limit = DETAIL_CHARS): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}\n\n… ${trimmed.length - limit} more characters in the run folder`
}

/** The last non-empty lines of a failed run's log. */
export function logTail(log: string, lines = 8): string {
  return log
    .split(/\r?\n/)
    .filter(line => line.trim())
    .slice(-lines)
    .join('\n')
}

/** Running jobs first, then the rest, each newest first. */
export function ordered(list: Job[]): Job[] {
  return [...list.filter(job => job.state === 'running'), ...list.filter(job => job.state !== 'running')]
}
