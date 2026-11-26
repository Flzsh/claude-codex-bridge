// The CLI theme's palette and helpers, shared by the flow and the companion.

import type { Lane } from '../../../../core/flow'
import { C, mix, SPIN } from '../../../../core/paint'

// The palette lives in core/paint, shared with the Claude Code sidebar.
export { C, mix, SPIN }

export const spin = (lane: Lane, t: number): string => {
  const one = SPIN[lane]
  return one.frames[Math.floor(t / one.step) % one.frames.length] ?? '·'
}

/** A highlight that sweeps across running text, like Claude Code's thinking line. */
export const shimmer = (base: string, t: number, len: number) => (i: number): string => {
  const span = len + 14
  const centre = ((t * 16) % span) - 7
  return mix(base, C.bright, Math.max(0, 1 - Math.abs(i - centre) / 4) * 0.85)
}

/** Each lane's line colour: a step quieter than its nodes. */
export const LINE: Record<Lane, string> = {
  you: mix(C.you, C.bg, 0.28),
  claude: mix(C.claude, C.bg, 0.28),
  gemini: mix(C.gemini, C.bg, 0.28),
  codex: mix(C.codex, C.bg, 0.28),
}

export const clock = (epoch: number): string => {
  const d = new Date(epoch * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
export const took = (s: number): string => {
  const n = Math.max(0, Math.round(s))
  return n < 60 ? `${n}s` : `${Math.floor(n / 60)}m${String(n % 60).padStart(2, '0')}s`
}
export const elapsed = (s: number): string => {
  const n = Math.max(0, Math.floor(s))
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}
export const fit = (text: string, room: number): string => (text.length > room ? text.slice(0, Math.max(0, room - 1)) + '…' : text)

/** Eighth blocks for meters and countdowns. */
export const EIGHTHS = ' ▏▎▍▌▋▊▉'
