// What the Claude Code pane knows of a workflow: the steps, the step now, who works and
// the review waiting (sidebarView, which the pane's buttons go by), and the small drawing
// helpers the pane's pictures share. The pictures themselves, with a workflow and
// without one, are core/pane.ts.

import { stagesFor, type Size } from './console'
import { fold, LANE, type FlowEvent, type Lane, type Step } from './flow'
import { esc, NAME, SPIN } from './paint'

export type Look = 'cli' | 'drawn'
/** The flow's start record, as the app lists it. */
export type FlowHead = { id: string; title: string; size: string | null; state: string | null }

export type PhaseRow = { label: string; state: 'done' | 'now' | 'next'; lanes: Lane[] }
export type WorkRow = { id: string; lane: Lane; title: string; detail: string; meter: [number, number] | null }
export type GateView = { id: string; title: string; summary: string; noAuto: boolean; wait: number | null; until: number | null }

/** What the sidebar shows of one flow. Nothing in it changes with the clock alone. */
export type SidebarView = {
  id: string
  title: string
  finished: boolean
  paused: boolean
  phases: PhaseRow[]
  /** The step now, counted from 0; -1 when the flow names no steps. */
  phase: number
  working: WorkRow[]
  gate: GateView | null
  /** The newest finished step, while nothing runs. */
  last: { lane: Lane; title: string } | null
}

/** A flow nobody touched for this long is no longer shown. */
export const QUIET_AFTER = 30 * 60
const MAX_PHASES = 9
const MAX_WORK = 4

const cap = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text)

/** The flow as the sidebar shows it, or null when there is none worth showing. */
export function sidebarView(
  events: readonly FlowEvent[], head: FlowHead | null, paused: boolean, at: number, workflow?: import('./workflow').Workflow,
): SidebarView | null {
  if (!head || !events.length) return null
  const lastT = events[events.length - 1]!.t
  const steps = [...fold(events, at).values()]
  const working = steps
    .filter(s => s.state === 'running' && s.kind !== 'gate' && s.kind !== 'steer')
    .sort((a, b) => b.t0 - a.t0 || LANE[b.lane] - LANE[a.lane])
  const gate = steps.find(s => s.state === 'waiting' && s.kind === 'gate') ?? null
  if (at - lastT > QUIET_AFTER && !working.length && !gate) return null
  const finished = head.state === 'done'
  const size = (['small', 'medium', 'large'].includes(head.size ?? '') ? head.size : 'large') as Size
  const labels = stagesFor(size, workflow).map(stage => stage.label).slice(0, MAX_PHASES)
  const top = steps.reduce((p, s) => Math.max(p, typeof s.phase === 'number' ? s.phase : -1), -1)
  const phase = Math.min(top, labels.length - 1)
  const phases: PhaseRow[] =
    phase < 0
      ? []
      : labels.map((label, p) => {
          const mine = steps.filter(s => s.phase === p && s.kind !== 'steer')
          // who: a review is yours; otherwise the agents who worked in that step, at most two
          const lanes: Lane[] = mine.some(s => s.kind === 'gate') ? ['you'] : [...new Set(mine.map(s => s.lane))].slice(0, 2)
          return { label, state: finished || p < phase ? 'done' : p === phase ? 'now' : 'next', lanes }
        })
  const detailOf = (s: Step): string => {
    const m = s.meter
    if (m) return m[1] !== null ? `${m[0]}/${m[1]} ${m[2]}` : `${m[0]} ${m[2]}`
    return s.progress ?? ''
  }
  const done = steps.filter(s => s.t1 !== undefined && s.kind !== 'steer').sort((a, b) => (b.t1 ?? 0) - (a.t1 ?? 0))[0]
  return {
    id: head.id,
    title: head.title,
    finished,
    paused,
    phases,
    phase,
    working: working.slice(0, MAX_WORK).map(s => ({
      id: s.id,
      lane: s.lane,
      title: s.title ?? 'working',
      detail: detailOf(s),
      meter: s.meter && s.meter[1] ? [s.meter[0], s.meter[1]] : null,
    })),
    gate: gate
      ? {
          id: gate.id,
          title: cap(gate.title ?? 'review the plan'),
          summary: gate.summary ?? '',
          noAuto: gate.noAuto === true,
          wait: typeof gate.wait === 'number' ? gate.wait : null,
          until: typeof gate.until === 'number' ? gate.until : null,
        }
      : null,
    last: !working.length && !gate && done ? { lane: done.lane, title: done.title ?? 'done' } : null,
  }
}

/** One line for a reader that cannot see the picture, and for the terminal. */
export function sidebarAlt(view: SidebarView): string {
  const now = view.phases[view.phase]
  const step = now ? `step ${view.phase + 1} of ${view.phases.length}, ${now.label}` : ''
  const who = view.working.map(w => `${NAME[w.lane]} ${w.title}`).join('; ')
  const state = view.finished ? 'finished' : view.gate ? `waiting for you: ${view.gate.title}` : view.paused ? 'paused' : who || 'between steps'
  return [`Workflow: ${view.title}`, step, state].filter(Boolean).join('. ')
}

// ---------------------------------------------------------------- shared by the pictures

/** The pictures' width in the pane: they are given this size outright, and it fits a narrow pane. */
export const SIDEBAR_W = 460
const PAD = 14

export const MONO = "'Cascadia Mono','Cascadia Code',Consolas,monospace"
export const SERIF = "Literata,Georgia,'Times New Roman',serif"

/** Shortens text to about `chars` characters. */
export const fit = (text: string, chars: number) => (text.length > chars ? text.slice(0, Math.max(1, chars - 1)).trimEnd() + '…' : text)
export const f = (n: number) => (Math.round(n * 10) / 10).toString()

/** A spinner of text frames, each frame shown in turn. */
export function spinner(lane: Lane, x: number, y: number, attrs: string): string {
  const { frames, step } = SPIN[lane]
  if (frames.length === 1) return `<text x="${f(x)}" y="${f(y)}" ${attrs}>${esc(frames[0])}</text>`
  const cycle = frames.length * step
  return frames
    .map((frame, k) => `<text x="${f(x)}" y="${f(y)}" ${attrs} visibility="hidden">${esc(frame)}<animate attributeName="visibility" values="visible;hidden" keyTimes="0;${(1 / frames.length).toFixed(4)}" calcMode="discrete" dur="${cycle.toFixed(2)}s" begin="${(k * step).toFixed(2)}s" repeatCount="indefinite"/></text>`)
    .join('')
}

/** The seconds left at a review, counting down by itself from the moment the picture loads. */
export function countdown(left: number, x: number, y: number, attrs: string, after: string): string {
  if (left > 120) return ''
  let out = ''
  for (let v = Math.ceil(left); v >= 1; v--) {
    const start = Math.max(0, left - v)
    const end = left - (v - 1)
    out += `<text x="${f(x)}" y="${f(y)}" ${attrs} visibility="${start === 0 ? 'visible' : 'hidden'}">${v}s`
    out += start === 0
      ? `<set attributeName="visibility" to="hidden" begin="${end.toFixed(2)}s" fill="freeze"/>`
      : `<set attributeName="visibility" to="visible" begin="${start.toFixed(2)}s" dur="${(end - start).toFixed(2)}s"/>`
    out += '</text>'
  }
  out += `<text x="${f(x)}" y="${f(y)}" ${attrs} visibility="hidden">${esc(after)}<set attributeName="visibility" to="visible" begin="${Math.max(0, left).toFixed(2)}s" fill="freeze"/></text>`
  return out
}

/** The picture's height before the first one is made. */
export const IDLE_H = 56
