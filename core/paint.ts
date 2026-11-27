// The two looks' colours and the drawn look's hand, with no page in them, so the
// app's flow, its companion and the Claude Code sidebar all draw alike.

import type { Lane } from './flow'

// ---------------------------------------------------------------- the terminal look

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

// ---------------------------------------------------------------- the drawn look

export type Fill = Lane | 'gold' | 'manila' | 'oat' | 'clay' | 'sheet'
export const FILL: Record<Fill, string> = { you: '#c9d6df', claude: '#efc3ae', gemini: '#c9b6cc', codex: '#b7c0a0', gold: '#e2b865', manila: '#ebdbbc', oat: '#e3dacc', clay: '#e9a183', sheet: '#fffdf8' }
export const HATCH: Record<Fill, string> = { you: '#8fa6b6', claude: '#d08b6e', gemini: '#9a85a0', codex: '#869170', gold: '#b98a2f', manila: '#c8b083', oat: '#b9ab92', clay: '#c96442', sheet: '#d8d2c4' }
export const DEEP: Record<Lane, string> = { you: '#5d7a8f', claude: '#b8643f', gemini: '#7d6488', codex: '#5f6f45' }
export const NAME: Record<Lane, string> = { you: 'You', claude: 'Claude', gemini: 'Gemini', codex: 'Codex' }
export const INK = '#141413'
export const CLAY_UI = '#a9522f'
export const GHOST = '#a39f95'

// The hand: every path is seeded by a key, so a thing is drawn the same way
// every time and can grow without its line jumping.
let seed = 7
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
export const j = (n: number) => (rand() - 0.5) * 2 * n
export function seedFrom(text: string) {
  let h = 9
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 2147483646
  seed = h + 1
}

/** A closed hand-drawn rounded box. With `fixed`, the number of wobble points does not depend on size. */
export function boxPath(x: number, y: number, w: number, h: number, r: number, wob = 0.9, fixed: [number, number] | null = null): string {
  const pts: [number, number][] = []
  const corner = (cx: number, cy: number, a0: number) => {
    for (let k = 0; k <= 3; k++) {
      const a = a0 + (k / 3) * Math.PI / 2
      pts.push([cx + Math.cos(a) * r + j(wob * 0.5), cy + Math.sin(a) * r + j(wob * 0.5)])
    }
  }
  const edge = (x1: number, y1: number, x2: number, y2: number, along: 0 | 1) => {
    const n = fixed ? fixed[along] : Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 46))
    for (let k = 1; k < n; k++) pts.push([x1 + ((x2 - x1) * k) / n + j(wob), y1 + ((y2 - y1) * k) / n + j(wob)])
  }
  corner(x + w - r, y + r, -Math.PI / 2); edge(x + w, y + r, x + w, y + h - r, 1)
  corner(x + w - r, y + h - r, 0); edge(x + w - r, y + h, x + r, y + h, 0)
  corner(x + r, y + h - r, Math.PI / 2); edge(x, y + h - r, x, y + r, 1)
  corner(x + r, y + r, Math.PI); edge(x + r, y, x + w - r, y, 0)
  const first = pts[0] ?? [x, y]
  // the pen runs on a little past its start: 4 px on a sheet, under a pixel on a small disc
  pts.push([first[0] + Math.min(4, w * 0.06), first[1] + j(Math.min(0.6, w * 0.02))])
  let d = `M${first[0].toFixed(1)} ${first[1].toFixed(1)}`
  for (let k = 1; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1]
    if (!a || !b) continue
    d += ` Q${a[0].toFixed(1)} ${a[1].toFixed(1)} ${((a[0] + b[0]) / 2).toFixed(1)} ${((a[1] + b[1]) / 2).toFixed(1)}`
  }
  // the stroke runs on just past where it began, as a pen does (it stopped half a stretch short, leaving a gap)
  const end = pts[pts.length - 1]
  if (end) d += ` L${end[0].toFixed(1)} ${end[1].toFixed(1)}`
  return d
}

/** A wobbly line; `n` fixes its number of points so it can stretch smoothly. */
export function linePath(x1: number, y1: number, x2: number, y2: number, wob = 0.8, step = 40, move = true, n: number | null = null): string {
  const count = n ?? Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / step))
  let d = move ? `M${x1.toFixed(1)} ${y1.toFixed(1)}` : ''
  for (let k = 1; k <= count; k++) {
    const x = x1 + ((x2 - x1) * k) / count + (k < count ? j(wob) : 0)
    const y = y1 + ((y2 - y1) * k) / count + (k < count ? j(wob) : 0)
    d += ` L${x.toFixed(1)} ${y.toFixed(1)}`
  }
  return d
}

/** Text made safe for markup. */
export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
