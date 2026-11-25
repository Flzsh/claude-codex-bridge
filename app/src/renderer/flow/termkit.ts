// The CLI theme's palette and helpers, shared by the flow and the companion.

import type { Lane } from '../../../../core/flow'

export const C = {
  bg: '#151413', sel: '#221f1c', hover: '#1c1a18', bar: '#1f1d1a',
  fg: '#d4cec2', bright: '#f3eee4', dim: '#8b857a', faint: '#56524b', rule: '#3a3732',
  you: '#7ea6d8', claude: '#d9825b', gemini: '#a98ddc', codex: '#84bf7d',
  amber: '#e3b15a', red: '#df6b5e', green: '#84bf7d',
} as const

/** Each agent's spinner, after its own command line tool. */
export const SPIN: Record<Lane, { frames: string[]; step: number }> = {
  claude: { frames: ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'], step: 0.11 },
  gemini: { frames: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'], step: 0.08 },
  codex: { frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], step: 0.08 },
  you: { frames: ['◉'], step: 1 },
}
export const spin = (lane: Lane, t: number): string => {
  const one = SPIN[lane]
  return one.frames[Math.floor(t / one.step) % one.frames.length] ?? '·'
}

const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
const mixCache = new Map<string, string>()
/** a toward b by k (in twelfths, so a frame reuses its colours). */
export function mix(a: string, b: string, k: number): string {
  const q = Math.max(0, Math.min(1, Math.round(k * 12) / 12))
  const key = a + b + q
  let out = mixCache.get(key)
  if (!out) {
    const x = hex(a), y = hex(b)
    out = '#' + x.map((v, i) => Math.round(v + ((y[i] ?? 0) - v) * q).toString(16).padStart(2, '0')).join('')
    mixCache.set(key, out)
  }
  return out
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
