// The Claude Code pane's picture of a workflow, stacked for a tall pane: the whole
// workflow on top (the steps across, then every step in its agent's lane, the way the
// app draws it) and, below it, what the step in focus is doing: its progress, meter and
// last actions, or at a review the points to decide and the time left. It is built from
// the app's own model (fold, layout, focusAt), so the pane and the app always agree.
//
// One layout pass draws both looks through a skin: the terminal look in squares and
// straight lines on a dark panel, the drawn look in discs and ink on paper. It moves by
// SMIL inside its own frame, so it animates without being drawn again; its times are
// fixed when the picture is made, and the picture is made again only when the flow changes.

import { fold, focusAt, GAP, graphCell, LANES, layout, type FlowEvent, type Lane, type Step } from './flow'
import { boxPath, C, CLAY_UI, DEEP, esc, FILL, GHOST, INK, linePath, mix, NAME, seedFrom } from './paint'
import { countdown, f, fit, MONO, SERIF, SIDEBAR_W, sidebarView, spinner, type FlowHead, type Look, type PhaseRow } from './sidebar'

const U = 1, D = 2, Lt = 4, Rt = 8

type Cell = { x: number; bits: number; lane: Lane }
export type PaneRow =
  | { kind: 'head'; label: string; cells: Cell[] }
  | { kind: 'gap' | 'conn' | 'pass'; cells: Cell[] }
  | { kind: 'step'; id: string; lane: Lane; title: string; state: string; gate: boolean; steer: boolean; right: string; focus: boolean; meter: [number, number] | null; cells: Cell[] }
  | { kind: 'live'; id: string; lane: Lane; text: string; cells: Cell[] }

export type PaneLine = { mark: string; text: string; who?: string }
export type PaneDetail = {
  id: string
  lane: Lane
  gate: { noAuto: boolean; wait: number | null; until: number | null } | null
  state: string
  title: string
  words: string
  meter: [number, number | null, string] | null
  lines: PaneLine[]
  summary: string
}

/** What the pane shows of one flow. Nothing in it changes with the clock alone. */
export type PaneModel = {
  id: string
  title: string
  size: string
  finished: boolean
  paused: boolean
  summary: string
  stages: PhaseRow[]
  stage: number
  rows: PaneRow[]
  /** Steps left out at the top, when the flow is long. */
  earlier: number
  detail: PaneDetail | null
  /** The line into each working step, as [row, column] cells from where it starts: the liquid runs down it. */
  flows: PaneFlow[]
}

export type PaneFlow = { lane: Lane; cells: [row: number, x: number][] }

/** The flows when the first `cut` rows are left out. */
function dropRows(flows: PaneFlow[], cut: number): PaneFlow[] {
  return flows
    .map(one => ({ ...one, cells: one.cells.filter(([row]) => row >= cut).map(([row, x]): [number, number] => [row - cut, x]) }))
    .filter(one => one.cells.length > 1)
}

const MAX_ROWS = 48
const STEP_LINES = 6
const GATE_LINES = 18

const duration = (s: number) => (s < 60 ? `${Math.max(1, Math.round(s))}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`)

/** The pane's model of the flow, or null when there is none worth showing. */
/** `busy`: Claude is at work. Between steps, when no step runs, the flow then ends in a row of
 * Claude working, so the picture never stands still while Claude does. */
export function paneModel(events: readonly FlowEvent[], head: FlowHead | null, paused: boolean, at: number, busy = false): PaneModel | null {
  const view = sidebarView(events, head, paused, at)
  if (!view || !head) return null
  const steps = fold(events, at)
  const focus = view.finished ? null : focusAt(events, steps, at).id
  const { lines } = layout(steps)
  const width = (LANES.length - 1) * GAP
  const cellsOf = (line: (typeof lines)[number]): Cell[] => {
    const out: Cell[] = []
    for (let x = 0; x <= width; x++) {
      const c = graphCell(line, x, Number.POSITIVE_INFINITY)
      if (c) out.push({ x, bits: c.bits, lane: c.lane })
    }
    return out
  }
  let rows: PaneRow[] = []
  for (const line of lines) {
    const cells = cellsOf(line)
    if (line.kind === 'head') rows.push({ kind: 'head', label: view.phases[line.phase]?.label.toLowerCase() ?? `step ${line.phase + 1}`, cells })
    else if (line.kind === 'gap' || line.kind === 'conn') rows.push({ kind: line.kind, cells })
    else if (line.kind === 'step') {
      const s = line.step
      const m = s.meter
      rows.push({
        kind: 'step',
        id: s.id,
        lane: s.lane,
        title: s.title ?? s.id,
        state: s.state ?? 'running',
        gate: s.kind === 'gate',
        steer: s.kind === 'steer',
        right: rightOf(s),
        focus: s.id === focus,
        meter: m && m[1] ? [m[0], m[1]] : null,
        cells,
      })
    } else if (line.kind === 'live') {
      const s = line.step
      const text = s.action ?? s.words ?? s.progress ?? ''
      rows.push(text ? { kind: 'live', id: s.id, lane: s.lane, text, cells } : { kind: 'pass', cells })
    } else rows.push({ kind: 'pass', cells })
    // a review's prompt and count rows keep only their lines: its answers are the pane's
    // buttons, and its time is in the focus box
  }
  // Claude at work between steps: a row of its own at the end, working
  if (busy && !paused && !view.finished && !rows.some(r => r.kind === 'step' && (r.state === 'running' || r.state === 'waiting')))
    rows.push({ kind: 'step', id: '~claude', lane: 'claude', title: 'working on the next step', state: 'running', gate: false, steer: false, right: '', focus: false, meter: null, cells: [] })
  // the line into each working step (a row per layout line, so its cells name rows)
  let flows: PaneFlow[] = [...steps.values()]
    .filter(st => st.state === 'running' && st.path && st.path.length > 1)
    .map(st => ({ lane: st.lane, cells: st.path!.map(([line, x]): [number, number] => [line, x]) }))
  // a long flow keeps its newest rows
  let earlier = 0
  if (rows.length > MAX_ROWS) {
    const cut = rows.length - MAX_ROWS
    earlier = rows.slice(0, cut).filter(r => r.kind === 'step').length
    rows = rows.slice(cut)
    flows = dropRows(flows, cut)
  }
  const end = [...events].reverse().find(e => e.kind === 'flow' && e.state === 'done')
  const step = focus ? steps.get(focus) : undefined
  return {
    id: view.id,
    title: view.title,
    size: head.size ?? 'large',
    finished: view.finished,
    paused,
    summary: end?.summary ?? '',
    stages: view.phases,
    stage: view.phase,
    rows,
    earlier,
    detail: step ? detailOf(step) : null,
    flows,
  }
}

function rightOf(s: Step): string {
  if (s.kind === 'gate') return s.state === 'waiting' ? 'waiting' : s.state === 'failed' ? 'declined' : s.auto ? 'carried on' : 'approved'
  if (s.state === 'failed') return 'failed'
  if (s.state === 'done' && s.t1 !== undefined) return duration(s.t1 - s.t0)
  const m = s.meter
  if (m) return m[1] !== null ? `${m[0]}/${m[1]} ${m[2]}` : `${m[0]} ${m[2]}`
  return ''
}

function detailOf(s: Step): PaneDetail {
  const gate = s.kind === 'gate'
  const lines: PaneLine[] = []
  for (const log of gate ? s.logs : s.logs.slice(-STEP_LINES)) {
    const [text, more] = log.text.split('|')
    // a point: "what|who proposed it"; a choice: "A|the question"
    if (log.mark === '?' && more !== undefined) lines.push({ mark: '?', text: `${(text ?? '').trim()}  ${more.trim()}` })
    else lines.push({ mark: log.mark, text: (text ?? '').trim(), ...(more !== undefined && log.mark === '#' ? { who: more.trim() } : {}) })
  }
  // a long review keeps its opening and every choice
  let kept = lines
  if (gate && lines.length > GATE_LINES) {
    const choices = lines.filter(l => l.mark === '?')
    const rest = lines.filter(l => l.mark !== '?')
    const room = Math.max(4, GATE_LINES - choices.length - 1)
    kept = [...rest.slice(0, room), { mark: '…', text: `${rest.length - room} more in the app` }, ...choices]
  }
  return {
    id: s.id,
    lane: gate ? 'you' : s.lane,
    gate: gate ? { noAuto: s.noAuto === true, wait: typeof s.wait === 'number' ? s.wait : null, until: typeof s.until === 'number' ? s.until : null } : null,
    state: s.state ?? 'running',
    title: s.title ?? s.id,
    words: s.words ?? (s.progress && !/[0-9]/.test(s.progress) ? s.progress : ''),
    meter: s.meter ?? null,
    lines: kept,
    summary: s.summary ?? '',
  }
}

/** One line for a reader that cannot see the picture, and for the terminal. */
export function paneAlt(m: PaneModel): string {
  const now = m.stages[m.stage]
  const step = now ? `step ${m.stage + 1} of ${m.stages.length}, ${now.label}` : ''
  const d = m.detail
  const waiting = d?.gate && d.state === 'waiting'
  const state = m.finished ? `finished${m.summary ? `: ${m.summary}` : ''}` : waiting ? `waiting for you: ${d.title}` : m.paused ? 'paused' : d ? `${NAME[d.lane]} ${d.title}` : 'between steps'
  return [`Workflow: ${m.title}`, step, state].filter(Boolean).join('. ')
}

// ---------------------------------------------------------------- the picture

export const PANE_W = SIDEBAR_W
/** The element takes at most this many characters of SVG. */
const SOURCE_LIMIT = 131072
const PAD = 16
const CW = 2.5 // px per graph column: lanes sit GAP columns (20 px) apart
const GX = PAD + 10
const TX = GX + (LANES.length - 1) * GAP * CW + 18
const HEIGHTS = { head: 22, gap: 6, conn: 10, step: 24, live: 18, pass: 4 } as const

/** What differs between the two looks: type, colours and the shapes things are drawn in. */
type Skin = {
  font: string
  /** px per character at a size */
  cw: (size: number) => number
  size: { title: number; text: number; small: number }
  ink: string
  bright: string
  dim: string
  faint: string
  amber: string
  green: string
  red: string
  lane: (l: Lane) => string
  /** The whole sheet. */
  frame: (w: number, h: number, waiting: boolean) => string
  rule: (x1: number, y: number, x2: number, key: string) => string
  dots: (x1: number, y: number, x2: number) => string
  /** One piece of the lines between steps. */
  seg: (x1: number, y1: number, x2: number, y2: number, lane: Lane) => string
  node: (x: number, y: number, kind: 'done' | 'now' | 'next' | 'gate' | 'failed' | 'steer', lanes: Lane[], key: string) => string
  /** The highlight on the row in focus. */
  focusRow: (x: number, y: number, w: number, h: number, lane: Lane, gate: boolean, key: string) => string
  /** A bar that loads under a working step. */
  loading: (x: number, y: number, w: number, lane: Lane, meter: [number, number] | null, key: string) => string
  /** Liquid running along a line (points from where it starts to the step it feeds). */
  liquid: (points: [number, number][], lane: Lane, key: string) => string
  /** The line from the first step to the step now, lit, with a light running along it. */
  sweep: (x1: number, y: number, x2: number, colour: string, run: boolean, key: string) => string
  /** The focus box, drawn under its content. */
  box: (x: number, y: number, w: number, h: number, lane: Lane, gate: boolean, key: string) => string
  /** The mark that says a step works. */
  working: (lane: Lane, x: number, y: number) => string
  meter: (x: number, y: number, w: number, k: number, lane: Lane) => string
  drain: (x: number, y: number, w: number, from: number, left: number | null, key: string) => string
  pulse: (x: number, y: number, colour: string) => string
}

const ATTR = (skin: Skin, size: number, colour: string, extra = '') => `font-family="${skin.font}" font-size="${size}" fill="${colour}"${extra ? ' ' + extra : ''}`

const cli: Skin = {
  font: MONO,
  cw: size => size * 0.6,
  size: { title: 13, text: 12, small: 10.5 },
  ink: C.fg,
  bright: C.bright,
  dim: C.dim,
  faint: C.faint,
  amber: C.amber,
  green: C.green,
  red: C.red,
  lane: l => C[l],
  frame: (w, h, waiting) => `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="8" fill="${C.bg}" stroke="${waiting ? mix(C.amber, C.bg, 0.4) : C.rule}"/>`,
  rule: (x1, y, x2) => `<line x1="${f(x1)}" y1="${f(y)}" x2="${f(x2)}" y2="${f(y)}" stroke="${C.rule}"/>`,
  dots: (x1, y, x2) => `<line x1="${f(x1)}" y1="${f(y)}" x2="${f(x2)}" y2="${f(y)}" stroke="${C.rule}" stroke-dasharray="2 3"/>`,
  seg: (x1, y1, x2, y2, lane) => `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${mix(C[lane], C.bg, 0.3)}" stroke-width="1.5"/>`,
  node: (x, y, kind, lanes) => {
    const sq = (size: number, ls: Lane[], dim: boolean, colour?: string) => {
      const colours = (ls.length ? ls : (['claude'] as Lane[])).map(l => colour ?? (dim ? mix(C[l], C.bg, 0.3) : C[l]))
      const h = size / 2
      let out = `<rect x="${f(x - h)}" y="${f(y - h)}" width="${size}" height="${size}" fill="${colours[0]}"/>`
      if (colours[1]) out += `<rect x="${f(x)}" y="${f(y - h)}" width="${f(h)}" height="${size}" fill="${colours[1]}"/>`
      return out
    }
    const beat = (colour: string, dur: string, half: number) =>
      `<rect x="${f(x - half)}" y="${f(y - half)}" width="${half * 2}" height="${half * 2}" fill="none" stroke="${colour}" stroke-width="1.3"><animate attributeName="opacity" values="1;.15;1" dur="${dur}" repeatCount="indefinite"/></rect>`
    if (kind === 'done') return sq(7, lanes, true)
    if (kind === 'next') return `<rect x="${f(x - 3.5)}" y="${f(y - 3.5)}" width="7" height="7" fill="${C.bg}" stroke="${C.faint}"/>`
    if (kind === 'failed') return `<text x="${f(x)}" y="${f(y + 4)}" text-anchor="middle" ${ATTR(cli, 12, C.red)}>✗</text>`
    if (kind === 'steer') return `<path d="M${f(x)} ${f(y - 4)} l4 4 l-4 4 l-4 -4 Z" fill="${C.you}"/>`
    if (kind === 'gate') return sq(9, ['you'], false, C.amber) + beat(C.amber, '1.4s', 7.5)
    return sq(9, lanes, false) + beat(C.bright, '1s', 7.5)
  },
  focusRow: (x, y, w, h, lane, gate) => `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${h}" rx="3" fill="${C.sel}"/><rect x="${f(x)}" y="${f(y)}" width="2" height="${h}" fill="${gate ? C.amber : C[lane]}"/>`,
  loading: (x, y, w, lane, meter, key) => {
    let out = `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="1.5" fill="${C.rule}"/>`
    if (meter) out += `<rect x="${f(x)}" y="${f(y)}" width="${f(w * Math.min(1, meter[0] / meter[1]))}" height="1.5" fill="${mix(C[lane], C.bg, 0.3)}"/>`
    out += `<clipPath id="ld-${key}"><rect x="${f(x)}" y="${f(y - 1)}" width="${f(w)}" height="4"/></clipPath>`
    return out + `<rect y="${f(y)}" width="54" height="1.5" fill="${C[lane]}" clip-path="url(#ld-${key})"><animate attributeName="x" values="${f(x - 54)};${f(x + w)}" dur="1.6s" repeatCount="indefinite"/></rect>`
  },
  sweep: (x1, y, x2, colour, run) => {
    const len = x2 - x1
    let out = `<line x1="${f(x1)}" y1="${f(y)}" x2="${f(x2)}" y2="${f(y)}" stroke="${mix(colour, C.bg, 0.55)}" stroke-width="2"/>`
    if (run) out += `<line x1="${f(x1)}" y1="${f(y)}" x2="${f(x2)}" y2="${f(y)}" stroke="${colour}" stroke-width="2.5" stroke-dasharray="${f(len)} ${f(len)}" stroke-dashoffset="${f(len)}"><animate attributeName="stroke-dashoffset" values="${f(len)};0;0" keyTimes="0;0.55;1" dur="2.4s" repeatCount="indefinite"/></line>`
    return out
  },
  box: (x, y, w, h, _lane, gate) => `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="5" fill="${gate ? mix(C.amber, C.bg, 0.92) : C.hover}" stroke="${gate ? mix(C.amber, C.bg, 0.45) : C.rule}"/>`,
  working: (lane, x, y) => spinner(lane, x, y, ATTR(cli, 12, C[lane])),
  meter: (x, y, w, k, lane) => `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="4" rx="1" fill="${C.rule}"/><rect x="${f(x)}" y="${f(y)}" width="${f(w * k)}" height="4" rx="1" fill="${C[lane]}"/>`,
  drain: (x, y, w, from, left) => {
    let out = `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="2" fill="${mix(C.amber, C.bg, 0.7)}"/>`
    if (left !== null) out += `<rect x="${f(x)}" y="${f(y)}" width="${f(w * from)}" height="2" fill="${C.amber}"><animate attributeName="width" from="${f(w * from)}" to="0" dur="${Math.max(0.1, left).toFixed(2)}s" fill="freeze"/></rect>`
    return out
  },
  pulse: (x, y, colour) => `<circle cx="${f(x)}" cy="${f(y)}" r="3" fill="${colour}"><animate attributeName="opacity" values="1;.25;1" dur="1.2s" repeatCount="indefinite"/></circle>`,
  // a lit pipe, and the agent's colour running down it toward the step
  liquid: (points, lane) => {
    const d = polyline(points)
    return `<path d="${d}" fill="none" stroke="${C[lane]}" stroke-opacity=".26" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`
      + `<path d="${d}" fill="none" stroke="${C[lane]}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="14 5 3 5"><animate attributeName="stroke-dashoffset" from="27" to="0" dur=".9s" repeatCount="indefinite"/></path>`
  },
}

const PAPER = '#fffdf8', INK2 = '#4a4741', INK3 = '#6b675f'
const drawn: Skin = {
  font: SERIF,
  cw: size => size * 0.55,
  size: { title: 14, text: 12.5, small: 11 },
  ink: INK,
  bright: INK,
  dim: INK2,
  faint: INK3,
  amber: CLAY_UI,
  green: DEEP.codex,
  red: CLAY_UI,
  lane: l => DEEP[l],
  frame: (w, h, waiting) => {
    seedFrom('pane-sheet' + h)
    const fixed: [number, number] = [6, Math.max(2, Math.round(h / 60))]
    return `<path d="${boxPath(4, 5, w - 7, h - 7, 10, 0.5, fixed)}" fill="${INK}" fill-opacity=".1"/>`
      + `<path d="${boxPath(1.5, 1.5, w - 6, h - 6, 10, 0.6, fixed)}" fill="${waiting ? '#fbf1da' : PAPER}" stroke="${INK}" stroke-width="1.4" stroke-linecap="round"/>`
  },
  rule: (x1, y, x2, key) => {
    seedFrom('pane-rule' + key)
    return `<path d="${linePath(x1, y, x2, y, 0.6, 30)}" fill="none" stroke="${INK}" stroke-opacity=".32" stroke-width="1"/>`
  },
  dots: (x1, y, x2) => `<line x1="${f(x1)}" y1="${f(y)}" x2="${f(x2)}" y2="${f(y)}" stroke="${INK}" stroke-opacity=".22" stroke-dasharray="1.5 3.5" stroke-linecap="round"/>`,
  seg: (x1, y1, x2, y2, lane) => `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${DEEP[lane]}" stroke-opacity=".6" stroke-width="1.5" stroke-linecap="round"/>`,
  node: (x, y, kind, lanes, key) => {
    const disc = (r: number, ls: Lane[], stroke: number, fill?: string) => {
      seedFrom('pane-node' + key)
      const ring = boxPath(x - r, y - r, r * 2, r * 2, r, 0.25)
      let d = `<path d="${ring}" fill="${fill ?? (ls.length ? FILL[ls[0]!] : FILL.oat)}"/>`
      if (!fill && ls[1]) d += `<path d="M${f(x)} ${f(y - r)} A${r} ${r} 0 0 1 ${f(x)} ${f(y + r)} Z" fill="${FILL[ls[1]]}"/>`
      return d + `<path d="${ring}" fill="none" stroke="${INK}" stroke-width="${stroke}"/>`
    }
    if (kind === 'done') return disc(4.6, lanes, 1.1) + `<path d="M${f(x - 2.1)} ${f(y + 0.2)} l1.5 1.6 l2.9 -3.2" fill="none" stroke="${INK}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>`
    if (kind === 'next') return `<circle cx="${f(x)}" cy="${f(y)}" r="4.2" fill="${PAPER}" stroke="${GHOST}" stroke-width="1" stroke-dasharray="1.8 1.6"/>`
    if (kind === 'failed') return `<text x="${f(x)}" y="${f(y + 4.5)}" text-anchor="middle" ${ATTR(drawn, 13, CLAY_UI, 'font-weight="700"')}>✗</text>`
    if (kind === 'steer') return `<path d="M${f(x)} ${f(y - 4.5)} l4.5 4.5 l-4.5 4.5 l-4.5 -4.5 Z" fill="${FILL.you}" stroke="${INK}" stroke-width="1" stroke-linejoin="round"/>`
    if (kind === 'gate') return disc(5.6, ['you'], 1.4, FILL.gold) + `<circle cx="${f(x)}" cy="${f(y)}" r="9" fill="none" stroke="${CLAY_UI}" stroke-width="1.4"><animate attributeName="r" values="8;9.6;8" dur="1.4s" repeatCount="indefinite"/></circle>`
    return disc(5.6, lanes, 1.4) + `<circle cx="${f(x)}" cy="${f(y)}" r="9" fill="none" stroke="${INK}" stroke-width="1.2" stroke-dasharray="4 2.6"><animateTransform attributeName="transform" type="rotate" from="0 ${f(x)} ${f(y)}" to="360 ${f(x)} ${f(y)}" dur="3.2s" repeatCount="indefinite"/></circle>`
  },
  focusRow: (x, y, w, h, lane, gate, key) => {
    seedFrom('pane-focus' + key)
    return `<path d="${boxPath(x, y, w, h, 6, 0.4, [6, 1])}" fill="${gate ? FILL.gold : FILL[lane]}" fill-opacity=".5"/>`
  },
  loading: (x, y, w, lane, meter, key) => {
    seedFrom('pane-pen' + key)
    const pen = linePath(x, y, x + w, y, 0.5, 16)
    let out = ''
    if (meter) {
      seedFrom('pane-meter' + key)
      out += `<path d="${linePath(x, y, x + w * Math.min(1, meter[0] / meter[1]), y, 0.4, 16)}" fill="none" stroke="${DEEP[lane]}" stroke-width="2" stroke-linecap="round"/>`
    }
    return out + `<path d="${pen}" pathLength="1" fill="none" stroke="${DEEP[lane]}" stroke-opacity=".8" stroke-width="1.4" stroke-linecap="round" stroke-dasharray=".2 1.2"><animate attributeName="stroke-dashoffset" values=".2;-1" dur="1.7s" repeatCount="indefinite"/></path>`
  },
  sweep: (x1, y, x2, colour, run, key) => {
    seedFrom('pane-done' + key)
    const d = linePath(x1, y, x2, y, 0.5, 18)
    let out = `<path d="${d}" fill="none" stroke="${INK}" stroke-opacity=".6" stroke-width="1.6" stroke-linecap="round"/>`
    if (run) out += `<path d="${d}" pathLength="1" fill="none" stroke="${colour}" stroke-opacity=".85" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 1" stroke-dashoffset="1"><animate attributeName="stroke-dashoffset" values="1;0;0" keyTimes="0;0.55;1" dur="2.4s" repeatCount="indefinite"/></path>`
    return out
  },
  box: (x, y, w, h, lane, gate, key) => {
    seedFrom('pane-box' + key)
    return `<path d="${boxPath(x + 2, y + 2.5, w, h, 8, 0.4, [6, 2])}" fill="${INK}" fill-opacity=".1"/>`
      + `<path d="${boxPath(x, y, w, h, 8, 0.5, [6, 2])}" fill="${gate ? FILL.gold : mix(FILL[lane], PAPER, 0.55)}" stroke="${INK}" stroke-width="1.3"/>`
  },
  working: (lane, x, y) => {
    const cx = x + 4, cy = y - 4
    return `<circle cx="${f(cx)}" cy="${f(cy)}" r="3.6" fill="${FILL[lane]}" stroke="${INK}" stroke-width="1"/><circle cx="${f(cx)}" cy="${f(cy)}" r="6.4" fill="none" stroke="${INK}" stroke-width="1" stroke-dasharray="3 2.2"><animateTransform attributeName="transform" type="rotate" from="0 ${f(cx)} ${f(cy)}" to="360 ${f(cx)} ${f(cy)}" dur="3.2s" repeatCount="indefinite"/></circle>`
  },
  meter: (x, y, w, k, lane) => {
    seedFrom('pane-detail-meter')
    return `<path d="${linePath(x, y + 2, x + w, y + 2, 0.4, 20)}" fill="none" stroke="${INK}" stroke-opacity=".22" stroke-width="3" stroke-linecap="round"/>`
      + `<path d="${linePath(x, y + 2, x + Math.max(1, w * k), y + 2, 0.4, 20)}" fill="none" stroke="${DEEP[lane]}" stroke-width="3" stroke-linecap="round"/>`
  },
  drain: (x, y, w, from, left, key) => {
    seedFrom('pane-drain' + key)
    const d = linePath(x, y, x + w, y, 0.4, 20)
    let out = `<path d="${d}" fill="none" stroke="${INK}" stroke-opacity=".25" stroke-width="1.6" stroke-linecap="round"/>`
    if (left !== null) out += `<path d="${d}" pathLength="1" fill="none" stroke="${CLAY_UI}" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="${from.toFixed(3)} 2"><animate attributeName="stroke-dasharray" from="${from.toFixed(3)} 2" to="0 2" dur="${Math.max(0.1, left).toFixed(2)}s" fill="freeze"/></path>`
    return out
  },
  pulse: (x, y) => `<circle cx="${f(x)}" cy="${f(y)}" r="3.2" fill="${FILL.clay}" stroke="${INK}" stroke-width=".9"><animate attributeName="r" values="3.2;2.2;3.2" dur="1.2s" repeatCount="indefinite"/></circle>`,
  // a wash in the agent's colour along the line, and ink running down it toward the step
  liquid: (points, lane) => {
    const d = polyline(points)
    return `<path d="${d}" fill="none" stroke="${FILL[lane]}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`
      + `<path d="${d}" fill="none" stroke="${DEEP[lane]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="13 5 3 6"><animate attributeName="stroke-dashoffset" from="27" to="0" dur="1s" repeatCount="indefinite"/></path>`
  },
}

/** About how wide one of the pane's cells is, in px. A little over, so the picture is never
 * narrower than the pane: one wider than its room is shrunk to it, whole. */
// A little under: the picture moves only in its own frame, and a frame wider than its room is
// narrowed while keeping its height, which shrinks the drawing inside it with blank bands. So
// it is laid out no wider than the pane, and the pane's ground fills what is left beside it.
const CELL_PX = 7
/** The least a picture is laid out at, for a very narrow pane. */
const SMALLEST = 200
const WIDEST = 620

/** How wide to lay the picture out for a pane `columns` cells across (0: not known yet): no
 * wider than the pane. In steps of 20 px, rounded down, so a small drag of the pane's edge
 * does not restart the motion. */
export function pictureWidth(columns: number): number {
  if (!(columns > 0)) return PANE_W
  return Math.floor(Math.min(WIDEST, Math.max(SMALLEST, columns * CELL_PX - 4)) / 20) * 20
}

/** How a picture is set: framed on its own ground, or bare, its frame and ground left to the
 * pane around it (the pane is then drawn in the look, and the picture is part of it). */
export type Setting = 'framed' | 'bare'

/** The pane's own colours in each look: its ground and edge, and what the app draws around the
 * picture (words, buttons drawn as coloured words, the text boxes). */
export type PaneTheme = {
  ground: string
  edge: string
  /** the edge while a review waits for you */
  waitingEdge: string
  ink: string
  dim: string
  accent: string
  ok: string
  warn: string
  bad: string
  running: string
  /** Laid under a text box or a block of the app's text. The app's boxes are see-through white
   * with near-black words (in its light mode), so on a dark ground they need a light slip. */
  slip: string | null
  mono: boolean
  italic: boolean
}

const DRAWN_PAPER = '#faf9f5' // the app's own paper
export const PANE_THEME: Record<Look, PaneTheme> = {
  cli: { ground: C.bg, edge: C.rule, waitingEdge: mix(C.amber, C.bg, 0.25), ink: C.fg, dim: C.dim, accent: C.claude, ok: C.green, warn: C.amber, bad: C.red, running: C.amber, slip: C.fg, mono: true, italic: false },
  drawn: { ground: DRAWN_PAPER, edge: INK, waitingEdge: '#a86f14', ink: INK, dim: '#6b675f', accent: CLAY_UI, ok: '#5f6f45', warn: '#a86f14', bad: '#b3392f', running: '#a86f14', slip: null, mono: false, italic: true },
}

/** The workflow on top, the step in focus below, in the app's look, laid out `width` px wide. */
export function paneSvg(m: PaneModel, look: Look, at: number, width: number = PANE_W, setting: Setting = 'framed'): string {
  const skin = look === 'drawn' ? drawn : cli
  const W = Math.max(SMALLEST, Math.round(width))
  let svg = draw(m, skin, at, W, setting)
  // a very long flow keeps fewer rows rather than lose the picture
  for (let keep = MAX_ROWS / 2; svg.length > SOURCE_LIMIT && keep >= 6; keep = Math.floor(keep / 2)) {
    const cut = Math.max(0, m.rows.length - keep)
    svg = draw({ ...m, rows: m.rows.slice(cut), earlier: m.earlier + m.rows.slice(0, cut).filter(r => r.kind === 'step').length, flows: dropRows(m.flows, cut) }, skin, at, W, setting)
  }
  return svg
}

/** The lanes' names beside their marks: in one line, or in two where the picture is too
 * narrow for one. `text` draws a name at a point in its lane's colour. */
function laneNames(skin: Skin, W: number, y: number, text: (x: number, y: number, name: string, colour: string) => string): { svg: string; rows: 1 | 2 } {
  const names = LANES.map(lane => (skin === cli ? lane : NAME[lane]))
  const nameW = (name: string) => name.length * skin.cw(skin.size.small) * (skin === drawn ? 1.15 : 1)
  const oneLine = names.reduce((sum, name) => sum + nameW(name) + 14, 0) <= W - PAD - TX
  let svg = ''
  let lx = TX
  names.forEach((name, i) => {
    if (!oneLine && i === 2) lx = TX
    svg += text(lx, y + 13 + (!oneLine && i >= 2 ? 13 : 0), name, skin.lane(LANES[i]!))
    lx += nameW(name) + 14
  })
  return { svg, rows: oneLine ? 1 : 2 }
}

/** A path through the points, each end drawn back by `trim` so it stops at the nodes' edges. */
function polyline(points: [number, number][], trim = 6): string {
  const pts = points.filter((pt, i) => i === 0 || pt[0] !== points[i - 1]![0] || pt[1] !== points[i - 1]![1]).map(pt => [...pt] as [number, number])
  const pull = (a: [number, number], b: [number, number]) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len <= trim) return
    a[0] += ((b[0] - a[0]) / len) * trim
    a[1] += ((b[1] - a[1]) / len) * trim
  }
  if (pts.length > 1) {
    pull(pts[0]!, pts[1]!)
    pull(pts[pts.length - 1]!, pts[pts.length - 2]!)
  }
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join(' ')
}

function gateLeft(d: PaneDetail, paused: boolean, at: number): number | null {
  const g = d.gate
  if (!g || g.noAuto || g.until === null || paused) return null
  return Math.max(0, g.until - at)
}

function draw(m: PaneModel, skin: Skin, at: number, W: number, setting: Setting): string {
  const sz = skin.size
  const t = (x: number, y: number, text: string, colour: string, size: number = sz.text, extra = '') =>
    `<text x="${f(x)}" y="${f(y)}" ${ATTR(skin, size, colour, extra)}>${esc(text)}</text>`
  const chars = (width: number, size: number = sz.text) => Math.max(4, Math.floor(width / skin.cw(size)))
  const italic = skin === drawn ? 'font-style="italic"' : ''
  let body = ''
  let y = 0

  // the head: the workflow's name, its size, and whether it runs
  const d = m.detail
  const waiting = Boolean(d?.gate && d.state === 'waiting')
  const state: [string, string] = m.finished ? ['done', skin.green] : waiting ? ['your turn', skin.amber] : m.paused ? ['paused', skin.amber] : ['live', skin === drawn ? INK3 : C.claude]
  const stateW = state[0].length * skin.cw(sz.small)
  const live = state[0] === 'live'
  // the size and step count give way to the title where the pane is narrow
  const fullMeta = `${m.size} · ${m.stages.length} steps`
  const roomWith = W - PAD - (skin === cli ? PAD + 18 : PAD + 2) - stateW - fullMeta.length * skin.cw(sz.small) - (live ? 40 : 28)
  const meta = roomWith / skin.cw(sz.title) >= 16 ? fullMeta : ''
  const metaW = meta.length * skin.cw(sz.small)
  if (skin === cli) body += t(PAD, 25, '◆', C.claude, sz.title)
  const tx = skin === cli ? PAD + 18 : PAD + 2
  body += t(tx, 25, fit(m.title, chars(W - PAD - tx - stateW - metaW - (live ? 40 : 28), sz.title)), skin.ink, sz.title, 'font-weight="700"')
  body += t(W - PAD - 2, 25, state[0], state[1], sz.small, `text-anchor="end" ${italic}`)
  if (live) body += skin.pulse(W - PAD - 2 - stateW - 8, 21, C.claude)
  body += t(W - PAD - 2 - stateW - (live ? 20 : 12), 25, meta, skin.faint, sz.small, `text-anchor="end" ${italic}`)
  y = 40

  // the steps across: done, now (lit, with a light running to it), and to come
  if (m.stages.length) {
    const n = m.stages.length
    const slot = (W - 2 * PAD) / n
    const xs = m.stages.map((_, i) => PAD + slot * (i + 0.5))
    const sy = y + 14
    body += skin.seg(xs[0]!, sy, xs[n - 1]!, sy, 'you').replace(/stroke="[^"]*"/, `stroke="${skin === cli ? C.rule : GHOST}"`)
    const nowI = m.finished ? n - 1 : Math.max(0, m.stage)
    const colour = waiting ? skin.amber : skin.lane(d?.lane ?? 'claude')
    if (nowI > 0) body += skin.sweep(xs[0]!, sy, xs[nowI]!, colour, !m.finished, 'stages')
    // too narrow for every name: numbers alone, and the name of the step it is at, whole
    const numbersOnly = chars(slot - 6, 10.5) < 7
    m.stages.forEach((st, i) => {
      const x = xs[i]!
      body += skin.node(x, sy, st.state === 'now' ? (waiting ? 'gate' : 'now') : st.state, st.state === 'now' && waiting ? ['you'] : st.lanes, `stage${i}`)
      const colour2 = st.state === 'now' ? skin.ink : st.state === 'done' ? skin.dim : skin === cli ? C.faint : GHOST
      const weight = st.state === 'now' ? ' font-weight="700"' : ''
      if (numbersOnly) {
        body += t(x, sy + 25, `${i + 1}`, colour2, 10.5, `text-anchor="middle"${weight}`)
        if (i === nowI) {
          const name = st.label.toLowerCase()
          const half = (name.length * skin.cw(10.5)) / 2
          body += t(Math.min(W - PAD - half, Math.max(PAD + half, x)), sy + 37, name, skin.ink, 10.5, 'text-anchor="middle" font-weight="700"')
        }
        return
      }
      wrap(`${i + 1} ${st.label.toLowerCase()}`, chars(slot - 6, 10.5), 2).forEach((part, k) => {
        body += t(x, sy + 25 + k * 12, part, colour2, 10.5, `text-anchor="middle"${weight}`)
      })
    })
    y = sy + 50
  }
  body += skin.rule(PAD, y, W - PAD, 'top')
  y += 8

  // the lanes' heads, and every step in its lane
  LANES.forEach((lane, i) => {
    body += skin.node(GX + i * GAP * CW, y + 9, 'done', [lane], `head${i}`).replace(/<path d="M[^"]*l1\.5 1\.6[^>]*>/, '')
  })
  const heads = laneNames(skin, W, y, (x, ty, name, colour) => t(x, ty, name, colour, sz.small, italic))
  body += heads.svg
  y += heads.rows === 1 ? 22 : 35
  if (m.earlier) {
    body += t(TX, y + 12, `… ${m.earlier} earlier step${m.earlier === 1 ? '' : 's'}`, skin.faint, sz.small, italic)
    y += 18
  }
  const middles: number[] = []
  m.rows.forEach((row, i) => {
    const h = HEIGHTS[row.kind]
    const cy = y + h / 2
    middles[i] = cy
    // the lines between the steps, in the lane colour of where they come from
    for (const c of row.cells) {
      const x = GX + c.x * CW
      if (c.bits & U) body += skin.seg(x, y, x, cy, c.lane)
      if (c.bits & D) body += skin.seg(x, cy, x, y + h, c.lane)
      if (c.bits & Lt) body += skin.seg(x - CW / 2, cy, x, cy, c.lane)
      if (c.bits & Rt) body += skin.seg(x, cy, x + CW / 2, cy, c.lane)
    }
    if (row.kind === 'head') {
      body += t(TX, cy + 4, row.label, skin.dim, sz.small, `font-weight="700" ${italic}`)
      // bold italic serif runs wider than the plain estimate
      body += skin.dots(TX + row.label.length * skin.cw(sz.small) * (skin === drawn ? 1.2 : 1) + 10, cy, W - PAD)
    } else if (row.kind === 'step') {
      const col = LANES.indexOf(row.lane) * GAP
      const nx = GX + col * CW
      // where a line goes on above or below, it meets the node
      const above = m.rows[i - 1]?.cells.find(c => c.x === col && c.bits & D)
      const below = m.rows[i + 1]?.cells.find(c => c.x === col && c.bits & U)
      if (above) body += skin.seg(nx, y, nx, cy, above.lane)
      if (below) body += skin.seg(nx, cy, nx, y + h, below.lane)
      const running = row.state === 'running'
      const waitingRow = row.gate && row.state === 'waiting'
      if (row.focus) body = skin.focusRow(PAD - 6, y + 1, W - 2 * PAD + 12, h - 2, row.lane, waitingRow, row.id) + body
      const kind = row.steer ? 'steer' : row.state === 'failed' ? 'failed' : waitingRow ? 'gate' : running ? 'now' : 'done'
      body += skin.node(nx, cy, kind, [row.lane], `row${row.id}`)
      const right = waitingRow ? (m.paused ? 'paused' : 'your turn') : row.right
      const rightColour = waitingRow || row.state === 'failed' ? skin.amber : running && row.meter ? skin.dim : skin.faint
      const room = chars(W - PAD - TX - (right ? right.length * skin.cw(sz.small) + 14 : 0))
      const titleColour = waitingRow ? skin.amber : running ? (skin === cli ? 'url(#shine)' : INK) : row.steer ? skin.lane('you') : row.state === 'failed' ? skin.red : skin.dim
      body += t(TX, cy + 4, fit(row.title, room), titleColour, sz.text, running || waitingRow ? 'font-weight="700"' : '')
      if (right) body += t(W - PAD, cy + 4, right, rightColour, sz.small, `text-anchor="end" ${italic}`)
      if (running) body += skin.loading(TX, y + h - 3, W - PAD - TX, row.lane, row.meter, esc(row.id).replace(/[^\w-]/g, '_'))
    } else if (row.kind === 'live') {
      body += t(TX + 4, cy + 4, skin === cli ? '⎿' : '↳', skin.faint, sz.small)
      body += t(TX + 20, cy + 4, fit(row.text, chars(W - PAD - TX - 20, sz.small)), skin.faint, sz.small, italic)
    }
    y += h
  })
  // the liquid running down the line into each working step (paused: it stands still)
  if (!m.paused && !m.finished) {
    for (const [k, one] of m.flows.entries()) {
      const points = one.cells.flatMap(([row, x]): [number, number][] => (middles[row] === undefined ? [] : [[GX + x * CW, middles[row]!]]))
      if (points.length > 1) body += skin.liquid(points, one.lane, `flow${k}`)
    }
  }
  y += 8

  // the step in focus: what it is doing, or what the review asks
  body += skin.rule(PAD, y, W - PAD, 'focus')
  y += 14
  const inner = W - 2 * PAD - 40
  if (m.finished) {
    body += t(PAD + 4, y + 12, '✓', skin.green, sz.text, 'font-weight="700"')
    body += t(PAD + 22, y + 12, 'Finished', skin.green, sz.text, 'font-weight="700"')
    y += 20
    for (const line of wrap(m.summary || 'every step is done', chars(W - 2 * PAD - 22), 4)) {
      body += t(PAD + 22, y + 12, line, skin.ink, sz.text)
      y += 17
    }
    y += 6
  } else if (!d) {
    body += t(PAD + 4, y + 12, 'between steps', skin.dim, sz.text, italic)
    y += 24
  } else {
    const gate = d.gate !== null && d.state === 'waiting'
    const colour = gate ? skin.amber : skin.lane(d.lane)
    const top = y - 6
    let c = ''
    // who it waits on: the review's title already says it is a review
    const who = gate ? (skin === cli ? 'you' : 'You') : skin === cli ? d.lane : NAME[d.lane]
    if (gate) c += t(PAD + 12, y + 14, '◉', skin.amber, sz.text)
    else if (d.state === 'running') c += skin.working(d.lane, PAD + 12, y + 14)
    else c += t(PAD + 12, y + 14, d.state === 'failed' ? '✗' : '✓', d.state === 'failed' ? skin.red : skin.green, sz.text)
    c += t(PAD + 28, y + 14, who, colour, sz.text, 'font-weight="700"')
    const left = gate ? gateLeft(d, m.paused, at) : null
    const said = gate ? (d.gate!.noAuto ? 'needs your yes' : m.paused ? 'paused' : left === null ? '' : 'carries on in') : d.state === 'running' ? 'working' : d.state
    const whoW = who.length * skin.cw(sz.text) + 10
    // where the pane is narrow the status words give way to the title; the countdown stays
    const clockW = left !== null ? 34 : 0
    const roomWith = (inner - whoW - said.length * skin.cw(sz.small) - clockW - 10) / skin.cw(sz.text)
    const status = roomWith >= 12 ? said : ''
    const statusW = status.length * skin.cw(sz.small) + clockW
    c += t(PAD + 28 + whoW, y + 14, fit(d.title, chars(inner - whoW - statusW - 10)), skin.bright, sz.text, 'font-weight="700"')
    if (left !== null && d.gate?.wait) {
      c += countdown(left, W - PAD - 12, y + 14, `${ATTR(skin, sz.text, skin.amber)} font-weight="700" text-anchor="end"`, 'now')
      c += t(W - PAD - 46, y + 14, status, skin.faint, sz.small, `text-anchor="end" ${italic}`)
    } else if (status) c += t(W - PAD - 12, y + 14, status, gate ? skin.amber : skin.faint, sz.small, `text-anchor="end" ${italic}`)
    y += 24
    if (d.words && !gate) {
      c += t(PAD + 28, y + 10, fit(d.words, chars(inner, sz.small)), skin.dim, sz.small, italic)
      y += 18
    }
    if (d.meter && !gate) {
      const [n, total, unit] = d.meter
      const label = total !== null ? `${n}/${total} ${unit}` : `${n} ${unit}`
      const bw = inner - label.length * skin.cw(sz.small) - 12
      if (total) c += skin.meter(PAD + 28, y + 5, bw, Math.min(1, n / total), d.lane)
      c += t(W - PAD - 12, y + 11, label, skin.dim, sz.small, 'text-anchor="end"')
      y += 18
    }
    // the last actions (● what it did, ⎿ what came back), or the review's points and choices
    for (const line of d.lines) {
      if (line.mark === 'h') {
        y += 4
        c += t(PAD + 28, y + 12, fit(line.text, chars(inner)), skin.ink, sz.text, 'font-weight="700"')
        y += 18
        continue
      }
      const mark = line.mark === '#' ? '•' : line.mark === '⎿' && skin === drawn ? '↳' : line.mark
      const markColour = line.mark === '?' ? skin.amber : line.mark === '●' ? colour : line.mark === '✓' ? skin.green : skin.faint
      const whoRoom = line.who ? line.who.replace(/\s+/g, '').length * 10 + 12 : 0
      const room = chars(inner - whoRoom)
      const parts = line.mark === '#' || line.mark === '?' ? wrap(line.text, room, 2) : [fit(line.text, room)]
      c += t(PAD + 14, y + 12, mark, markColour, sz.text)
      parts.forEach((part, k) => {
        c += t(PAD + 28, y + 12 + k * 16, part, line.mark === '⎿' || line.mark === '…' ? skin.dim : skin.ink, sz.text, line.mark === '…' ? italic : '')
      })
      if (line.who) {
        let wx = W - PAD - 12
        for (const ch of [...line.who.replace(/\s+/g, '')].reverse()) {
          const lane: Lane = ch === 'C' ? 'claude' : ch === 'G' ? 'gemini' : ch === 'X' ? 'codex' : 'you'
          c += t(wx, y + 12, ch, skin.lane(lane), sz.small, 'text-anchor="end" font-weight="700"')
          wx -= 10
        }
      }
      y += parts.length * 16 + 3
    }
    if (d.summary && d.state !== 'running' && !gate) {
      c += t(PAD + 28, y + 12, fit(d.summary, chars(inner, sz.small)), skin.dim, sz.small, italic)
      y += 18
    }
    if (gate && d.gate && !d.gate.noAuto) {
      const from = left !== null && d.gate.wait ? Math.min(1, left / d.gate.wait) : 1
      c += skin.drain(PAD + 28, y + 8, inner, from, left, d.id)
      y += 18
    }
    y += 6
    // the box round the focus, amber while it waits for you
    body += skin.box(PAD, top, W - 2 * PAD, y - top, d.lane, gate, d.id) + c
    y += 10
  }

  const H = Math.ceil(y + 6)
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  if (skin === cli) s += `<defs><linearGradient id="shine" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="80" y2="0"><stop offset="0" stop-color="${C.fg}"/><stop offset=".5" stop-color="${C.bright}"/><stop offset="1" stop-color="${C.fg}"/><animateTransform attributeName="gradientTransform" type="translate" from="-100 0" to="${W} 0" dur="2.2s" repeatCount="indefinite"/></linearGradient></defs>`
  return s + (setting === 'framed' ? skin.frame(W, H, waiting) : '') + body + '</svg>'
}

/** Words into lines of at most `chars` characters; the last line ends in … when there is more. */
function wrap(text: string, chars: number, most: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > chars) {
      out.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  if (out.length > most) {
    const kept = out.slice(0, most)
    kept[most - 1] = fit(`${kept[most - 1]} ${out.slice(most).join(' ')}`, chars)
    return kept
  }
  return out.map(l => fit(l, chars))
}

// ---------------------------------------------------------------- with no workflow

/** What the pane shows with no workflow running: Claude's state, the last workflow, recent runs. */
export type EmptyModel = {
  busy: boolean
  last: { title: string; finished: boolean; summary: string; lanes: Lane[]; steps: number; reviews: number; ago: string } | null
  runs: { provider: 'codex' | 'gemini'; title: string; state: 'running' | 'done' | 'failed' | 'lost'; ago: string }[]
}

/** Seconds as a rough age: "just now", "12 min ago", "3h ago", "2d ago". */
export function ago(seconds: number): string {
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}

/** The last workflow in a flow file, however long ago it ran, as the empty pane recalls it. */
export function lastFlow(events: readonly FlowEvent[], id: string | null, at: number): EmptyModel['last'] {
  if (!id) return null
  const mine = events.filter(e => e.flow === id)
  const start = mine.find(e => e.kind === 'flow' && e.title !== undefined)
  if (!start || !mine.length) return null
  const end = mine.find(e => e.kind === 'flow' && e.state === 'done')
  const list = [...fold(mine, Number.POSITIVE_INFINITY).values()].filter(s => s.kind !== 'steer').sort((a, b) => a.t0 - b.t0)
  return {
    title: start.title ?? 'workflow',
    finished: Boolean(end),
    summary: end?.summary ?? '',
    lanes: list.map(s => s.lane).slice(0, 26),
    steps: list.filter(s => s.kind !== 'gate').length,
    reviews: list.filter(s => s.kind === 'gate').length,
    ago: ago(at - (end?.t ?? mine[mine.length - 1]!.t)),
  }
}

/** The shape of a workflow before one runs, in the order it goes: who does what. */
const SHAPE: [Lane, string, string][] = [
  ['you', 'you say what it should do', 'in the chat; workflows show here'],
  ['claude', 'claude sizes it and plans it', 'small, medium or large'],
  ['gemini', 'gemini writes a second plan', 'for large work, before you decide'],
  ['codex', 'codex builds, claude joins in', 'each step shows here as it works'],
  ['you', 'you answer the review', 'approve, pause, change or decline'],
  ['claude', 'claude checks it and ships', 'nothing is pushed without your yes'],
]
const SHAPE_STAGES = ['ask', 'plan', 'build', 'review', 'check & ship']
/** The empty picture is drawn this much larger than it is laid out: larger type, and it fills
 * more of the room a quiet pane leaves blank. A narrow pane keeps the type as it is, for room. */
const EMPTY_SCALE = 1.15
/** The empty picture is laid out this wide at the usual pane width (460). */
export const EMPTY_W = 400

/** How wide the empty picture is laid out, to be drawn `drawnWidth` px wide. */
export function emptyLayoutWidth(drawnWidth: number): number {
  return Math.round(Math.max(drawnWidth / EMPTY_SCALE, Math.min(drawnWidth, 300), SMALLEST))
}

/** One line for a reader that cannot see the picture, and for the terminal. */
export function emptyAlt(m: EmptyModel): string {
  const last = m.last ? `Last workflow: ${m.last.title}, ${m.last.finished ? 'finished' : 'stopped'} ${m.last.ago}.` : ''
  return [`No workflow is running. Claude is ${m.busy ? 'working' : 'ready'}.`, last].filter(Boolean).join(' ')
}

/** The pane with no workflow: the shape of one, waiting for you, then what ran last. */
export function emptySvg(m: EmptyModel, look: Look, width: number = PANE_W, setting: Setting = 'framed'): string {
  const skin = look === 'drawn' ? drawn : cli
  // laid out narrower than it is drawn, so it comes out larger (the pane never enlarges a
  // picture itself)
  const drawnW = Math.max(SMALLEST, Math.round(width))
  const W = emptyLayoutWidth(drawnW)
  const sz = skin.size
  const t = (x: number, y: number, text: string, colour: string, size: number = sz.text, extra = '') =>
    `<text x="${f(x)}" y="${f(y)}" ${ATTR(skin, size, colour, extra)}>${esc(text)}</text>`
  const chars = (width: number, size: number = sz.text) => Math.max(4, Math.floor(width / skin.cw(size)))
  const italic = skin === drawn ? 'font-style="italic"' : ''
  const ghost = skin === cli ? C.faint : GHOST
  let body = ''

  // the head: no workflow yet, and Claude's own state ("claude" gives way where it is narrow)
  if (skin === cli) body += t(PAD, 25, '◆', C.claude, sz.title)
  const tx = skin === cli ? PAD + 18 : PAD + 2
  const title = skin === cli ? 'no workflow yet' : 'No workflow yet'
  body += t(tx, 25, title, skin.ink, sz.title, 'font-weight="700"')
  const state = m.busy ? 'working' : 'ready'
  body += t(W - PAD - 2, 25, state, m.busy ? skin.ink : skin.dim, sz.small, `text-anchor="end" ${italic}`)
  const who = skin === cli ? 'claude' : 'Claude'
  const titleEnd = tx + title.length * skin.cw(sz.title) * 1.08 + 14
  const stateX = W - PAD - 2 - state.length * skin.cw(sz.small) - 8
  const withWho = stateX - who.length * skin.cw(sz.small) * 1.1 - 12 - 8 >= titleEnd
  const markX = withWho ? stateX - who.length * skin.cw(sz.small) * 1.1 - 12 : stateX - 4
  if (withWho) body += t(stateX, 25, who, skin.lane('claude'), sz.small, `text-anchor="end" font-weight="700" ${italic}`)
  if (markX - 8 >= titleEnd) body += m.busy ? skin.working('claude', markX - 4, 25) : t(markX, 25, '·', skin.dim, sz.small)

  // the steps across, the first one yours and lit
  const sy = 60
  const slot = (W - 2 * PAD) / SHAPE_STAGES.length
  const xs = SHAPE_STAGES.map((_, i) => PAD + slot * (i + 0.5))
  body += `<line x1="${f(xs[0]!)}" y1="${sy}" x2="${f(xs[xs.length - 1]!)}" y2="${sy}" stroke="${skin === cli ? C.rule : GHOST}" stroke-dasharray="3 3"/>`
  SHAPE_STAGES.forEach((label, i) => {
    body += skin.node(xs[i]!, sy, i === 0 ? 'now' : 'next', ['you'], `shape-stage${i}`)
    wrap(`${i + 1} ${label}`, chars(slot - 6, 10.5), 2).forEach((part, k) => {
      body += t(xs[i]!, sy + 25 + k * 12, part, i === 0 ? skin.ink : ghost, 10.5, `text-anchor="middle"${i === 0 ? ' font-weight="700"' : ''}`)
    })
  })
  let y = sy + 52
  body += skin.rule(PAD, y, W - PAD, 'shape-top')
  y += 8

  // who takes part, and the order it goes in: each step in its lane, the first one yours
  LANES.forEach((lane, i) => {
    body += skin.node(GX + i * GAP * CW, y + 9, 'done', [lane], `shape-head${i}`).replace(/<path d="M[^"]*l1\.5 1\.6[^>]*>/, '')
  })
  const heads = laneNames(skin, W, y, (x, ty, name, colour) => t(x, ty, name, colour, sz.small, italic))
  body += heads.svg
  y += heads.rows === 1 ? 30 : 43
  const ROW_H = 50
  let prevX: number | null = null
  SHAPE.forEach(([lane, what, hint], i) => {
    const x = GX + LANES.indexOf(lane) * GAP * CW
    const cy = y + 10
    if (prevX !== null) {
      body += `<path d="M${f(prevX)} ${f(cy - ROW_H + 6)} V${f(cy - 14)} H${f(x)} V${f(cy - 6)}" fill="none" stroke="${skin.lane(lane)}" stroke-opacity="${skin === cli ? 0.45 : 0.35}" stroke-width="1.3" stroke-dasharray="2.5 2.5"/>`
    }
    body += skin.node(x, cy, i === 0 ? 'now' : 'next', [lane], i === 0 ? 'shape-you' : `shape-row${i}`)
    body += t(TX, cy + 4, fit(what, chars(W - PAD - TX)), i === 0 ? skin.ink : skin.dim, sz.text, i === 0 ? 'font-weight="700"' : '')
    body += t(TX, cy + 20, fit(hint, chars(W - PAD - TX, sz.small)), ghost, sz.small, italic)
    prevX = x
    y += ROW_H
  })
  y += 2

  // the last workflow: its steps by who did them, how it ended and when
  if (m.last) {
    const l = m.last
    body += skin.rule(PAD, y, W - PAD, 'shape-last')
    y += 22
    body += t(PAD + 4, y, skin === cli ? 'last workflow' : 'Last workflow', skin.dim, sz.small, `font-weight="700" ${italic}`)
    const end = `${l.finished ? '✓ finished' : 'stopped'} · ${l.ago}`
    body += t(W - PAD - 2, y, end, l.finished ? skin.green : skin.faint, sz.small, `text-anchor="end" ${italic}`)
    y += 22
    body += t(PAD + 4, y, fit(l.title, chars(W - 2 * PAD - 8)), skin.ink, sz.text, 'font-weight="700"')
    y += 18
    l.lanes.forEach((lane, i) => {
      const x = PAD + 10 + i * 16
      if (i) body += skin.seg(x - 11, y, x - 5, y, l.lanes[i - 1]!)
      body += skin.node(x, y, 'done', [lane], `last${i}`)
    })
    const count = `${l.steps} step${l.steps === 1 ? '' : 's'}${l.reviews ? ` · ${l.reviews} review${l.reviews === 1 ? '' : 's'}` : ''}`
    body += t(W - PAD - 2, y + 4, count, skin.faint, sz.small, `text-anchor="end" ${italic}`)
    y += 12
    if (l.summary) {
      for (const line of wrap(l.summary, chars(W - 2 * PAD - 8, sz.small), 2)) {
        y += 16
        body += t(PAD + 4, y, line, skin.dim, sz.small, italic)
      }
    }
    y += 12
  }

  // the last Codex and Gemini runs
  if (m.runs.length) {
    body += skin.rule(PAD, y, W - PAD, 'shape-runs')
    y += 22
    body += t(PAD + 4, y, skin === cli ? 'recent runs' : 'Recent runs', skin.dim, sz.small, `font-weight="700" ${italic}`)
    for (const r of m.runs) {
      y += 22
      const name = skin === cli ? r.provider : NAME[r.provider]
      if (r.state === 'running') body += skin.working(r.provider, PAD + 2, y)
      else body += t(PAD + 4, y, r.state === 'done' ? '✓' : '✗', r.state === 'done' ? skin.green : skin.red, sz.small)
      body += t(PAD + 20, y, name, skin.lane(r.provider), sz.small, 'font-weight="700"')
      const titleX = PAD + 20 + 7 * skin.cw(sz.small) + 6
      body += t(titleX, y, fit(r.title, chars(W - PAD - titleX - r.ago.length * skin.cw(sz.small) - 16, sz.small)), skin.dim, sz.small)
      body += t(W - PAD - 2, y, r.ago, skin.faint, sz.small, `text-anchor="end" ${italic}`)
    }
    y += 14
  }

  const H = Math.ceil(y + 6)
  const scale = drawnW / W
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${drawnW}" height="${Math.round(H * scale)}" viewBox="0 0 ${W} ${H}">` + (setting === 'framed' ? skin.frame(W, H, false) : '') + body + '</svg>'
}
