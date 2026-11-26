// The companion: a small loop on the desktop that says what is going on
// without getting in the way. The loop has one segment per workflow step (a
// circle in the drawn look, a square in the terminal look): steps done are
// inked in, the step now is lit in its agent's colour and moves, the steps to
// come are faint. Beside it, one short line of what is happening. With no
// workflow it is Claude's own status: thinking, the tool it is using, or ready.
// On hover a small row opens above it: the step's name and Approve / Pause / Open.

import { stagesFor, type Size } from '../../../core/console'
import { fold, LANE, type Lane, type Step } from '../../../core/flow'
import { gateLeft, type FlowPayload, type Theme } from './flow/controller'
import { boxPath, CLAY_UI, clamp, DEEP, esc, FILL, HATCH, INK, j, seedFrom } from './flow/ink'
import { C, mix, spin } from './flow/termkit'

type Claude = { state: 'thinking' | 'tool' | 'idle'; detail: string; since: number; t: number } | null
type State = { visible: boolean; busy: boolean; theme: Theme; flow: FlowPayload; runs: { who: string; title: string; since: number }[]; claude: Claude }
type Companion = {
  on(event: 'companion' | 'companion-row', listener: (payload: unknown) => void): () => void
  companionOpen(): Promise<void>
  answerGate(gate: string, answer: string, text?: string, t0?: number): Promise<unknown>
  setPaused(paused: boolean): Promise<unknown>
}

const bridge = (window as unknown as { bridge: Companion }).bridge
const shell = document.getElementById('shell') as HTMLElement
const canvas = document.getElementById('cli') as HTMLCanvasElement
const drawnHost = document.getElementById('drawn') as HTMLElement
/** The pill: small enough to sit in a corner without covering work. The window adds a margin for the shadow. */
const W = 252, H = 46, ROW = 30

const MONO = "'Cascadia Mono', 'Cascadia Code', Consolas, monospace"

let state: State | null = null
let open = false
type Hot = { x: number; y: number; w: number; h: number; run: () => void }
let hots: Hot[] = []
let drawnKey = ''

const now = () => Date.now() / 1000

/** What the loop and the line say now. */
function situation(at: number) {
  const steps = [...fold(state?.flow.events ?? [], at).values()]
  const working = steps.filter(s => s.state === 'running' && s.kind !== 'gate' && s.kind !== 'steer').sort((a, b) => b.t0 - a.t0 || LANE[b.lane] - LANE[a.lane])
  const gate = steps.find(s => s.state === 'waiting' && s.kind === 'gate') ?? null
  const done = steps.filter(s => s.t1 !== undefined && s.t1 <= at && s.kind !== 'steer').sort((a, b) => (b.t1 ?? 0) - (a.t1 ?? 0))
  const phase = steps.reduce((p, s) => Math.max(p, typeof s.phase === 'number' ? s.phase : -1), -1)
  const info = state?.flow.flow ?? null
  const live = Boolean(info && info.state !== 'done' && (working.length || gate || (steps.length && at - Math.max(...steps.map(s => s.t1 ?? s.t0)) < 600)))
  const size = (info?.size ?? 'large') as Size
  const phases = stagesFor(['small', 'medium', 'large'].includes(size) ? size : 'large').map(stage => stage.label)
  return { steps, working, gate, done, phase, phases, live }
}

type Line = { who: Lane | null; main: string; tail: string; tone: 'work' | 'gate' | 'calm' }

/** One short line: the review waiting, who works on what, or Claude's own status. */
function lineFor(at: number, s: ReturnType<typeof situation>): Line {
  const g = s.gate
  if (g) {
    const left = gateLeft(g, at)
    return { who: 'you', main: cap(g.title ?? 'review the plan'), tail: g.noAuto ? 'your yes' : left === null ? 'paused' : `${left}s`, tone: 'gate' }
  }
  const first = s.working[0]
  if (s.live && first) {
    const [n, of] = first.meter ?? [null, null]
    const more = s.working.length > 1 ? ` +${s.working.length - 1}` : ''
    return { who: first.lane, main: cap(first.title ?? 'working'), tail: (n !== null ? (of ? `${n}/${of}` : String(n)) : '') + more, tone: 'work' }
  }
  const run = state?.runs[0]
  if (run) return { who: (['codex', 'gemini'].includes(run.who) ? run.who : 'codex') as Lane, main: run.title, tail: '', tone: 'work' }
  const claude = state?.claude
  if (claude && claude.state !== 'idle') return { who: 'claude', main: claude.state === 'thinking' ? 'Thinking' : cap(claude.detail || 'working'), tail: '', tone: 'work' }
  if (s.live && s.done[0]) return { who: s.done[0].lane, main: cap(s.done[0].title ?? 'done'), tail: 'done', tone: 'calm' }
  return { who: 'claude', main: 'Ready', tail: '', tone: 'calm' }
}
const cap = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text)

/** One circle of the loop: a workflow step, who did or does it, and whether it is done, now or to come. */
type Node = { state: 'done' | 'now' | 'next'; lanes: Lane[] }

/** The loop: one node per step of the workflow; with no workflow, Claude alone going round. */
function loopFor(at: number, s: ReturnType<typeof situation>, line: Line) {
  const g = s.gate
  let left: number | null = null
  if (g && typeof g.until === 'number' && typeof g.wait === 'number') left = clamp((g.until - at) / g.wait)
  if (!s.live || s.phase < 0) return { nodes: [] as Node[], lane: (line.who ?? 'claude') as Lane, busy: line.tone === 'work', left }
  const nodes: Node[] = s.phases.map((_, p) => {
    const mine = s.steps.filter(step => step.phase === p && step.kind !== 'steer')
    // who: the review is yours; otherwise the agents who worked in that step, at most two
    const lanes: Lane[] = mine.some(step => step.kind === 'gate') ? ['you'] : [...new Set(mine.map(step => step.lane))].slice(0, 2)
    return { state: p < s.phase ? 'done' : p === s.phase ? 'now' : 'next', lanes }
  })
  const lane = (g ? 'you' : s.working[0]?.lane ?? nodes[s.phase]?.lanes[0] ?? 'claude') as Lane
  return { nodes, lane, busy: Boolean(s.working.length || g), left }
}

function act(kind: 'approve' | 'pause' | 'open' | 'decline', gate: Step | null) {
  if (kind === 'open') void bridge.companionOpen()
  else if (kind === 'pause') void bridge.setPaused(!(state?.flow.paused ?? false))
  else if (gate) void bridge.answerGate(gate.id, kind, undefined, gate.t0)
}

/** The answers the hover row offers. */
function actionsFor(s: ReturnType<typeof situation>): [string, 'approve' | 'pause' | 'open' | 'decline'][] {
  if (s.gate) return s.gate.noAuto ? [['Yes', 'approve'], ['Not now', 'decline'], ['Open', 'open']] : [['Approve', 'approve'], [state?.flow.paused ? 'Resume' : 'Pause', 'pause'], ['Open', 'open']]
  if (s.live) return [[state?.flow.paused ? 'Resume' : 'Pause', 'pause'], ['Open', 'open']]
  return [['Open', 'open']]
}

// ---------------------------------------------------------------- terminal look: a square tile

/** The terminal look's companion is a square tile: a square track with a small square per step on it. */
const TILE = 108

function drawCli(at: number) {
  const dpr = window.devicePixelRatio || 1
  // always as tall as tile + row: a canvas that changes size is cleared, and flashes
  const h = TILE + ROW
  if (canvas.width !== Math.round(TILE * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(TILE * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${TILE}px`
    canvas.style.height = `${h}px`
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, TILE, h)
  hots = []
  const s = situation(at)
  const line = lineFor(at, s)
  const loop = loopFor(at, s, line)
  const top = h - TILE
  const gate = line.tone === 'gate'

  const box = (x: number, y: number, w: number, hh: number) => {
    ctx.beginPath()
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, hh - 1, 6)
    ctx.fillStyle = C.bg
    ctx.fill()
    ctx.strokeStyle = gate ? mix(C.amber, C.bg, 0.35) : C.rule
    ctx.lineWidth = 1
    ctx.stroke()
  }
  box(0, top, TILE, TILE)

  // the track
  const side = 84, sx = 12, sy = top + 12
  const per = side * 4
  const pointAt = (d: number): [number, number] => {
    const k = ((d % per) + per) % per
    if (k < side) return [sx + k, sy]
    if (k < side * 2) return [sx + side, sy + (k - side)]
    if (k < side * 3) return [sx + side - (k - side * 2), sy + side]
    return [sx, sy + side - (k - side * 3)]
  }
  /** Draws the track from one distance to another, round the corners. */
  const along = (from: number, to: number, color: string, width: number) => {
    if (to <= from) return
    ctx.beginPath()
    ctx.moveTo(...pointAt(from))
    for (let c = Math.ceil(from / side) * side; c < to; c += side) ctx.lineTo(...pointAt(c))
    ctx.lineTo(...pointAt(to))
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineJoin = 'miter'
    ctx.stroke()
  }
  along(0, per, C.rule, 1)
  const lane = C[loop.lane]
  const square = (x: number, y: number, size: number, lanes: Lane[], dim: boolean) => {
    const half = size / 2
    const colours = lanes.length ? lanes.map(one => (dim ? mix(C[one], C.bg, 0.3) : C[one])) : [C.dim]
    ctx.fillStyle = colours[0]!
    ctx.fillRect(Math.round(x - half), Math.round(y - half), size, size)
    if (colours[1]) { ctx.fillStyle = colours[1]; ctx.fillRect(Math.round(x), Math.round(y - half), Math.ceil(half), size) }
  }
  const nodes = loop.nodes
  const start = side / 2 // the first step sits at the top's middle; the steps go round clockwise
  const placeOf = (i: number) => start + (i * per) / Math.max(1, nodes.length)

  if (!nodes.length) {
    // no workflow: Claude alone, one square going round while it works, resting at the top when ready
    const d = start + (line.tone === 'work' ? (at * 46) % per : 0)
    if (line.tone === 'work') for (let k = 1; k <= 10; k++) along(d - k * 5, d - (k - 1) * 5, mix(lane, C.bg, k / 10), 2)
    square(...pointAt(d), 9, [loop.lane], line.tone !== 'work')
  } else {
    const nowAt = Math.max(0, nodes.findIndex(one => one.state === 'now'))
    const target = placeOf(nowAt)
    // the steps so far, lit: a light runs from the first step to the one now, rests there, and starts again
    const cycle = 2.4, run = 1.3
    const k = Math.min(1, (at % cycle) / run)
    const eased = 1 - Math.pow(1 - k, 3)
    along(start, start + (target - start) * eased, mix(gate ? C.amber : lane, C.bg, 0.35), 2)
    if (k < 1) {
      const head = start + (target - start) * eased
      along(Math.max(start, head - 10), head, gate ? C.amber : C.bright, 2.5)
    }
    nodes.forEach((one, i) => {
      const [x, y] = pointAt(placeOf(i))
      if (one.state === 'done') square(x, y, 8, one.lanes, true)
      else if (one.state === 'next') {
        ctx.fillStyle = C.bg
        ctx.fillRect(x - 4, y - 4, 8, 8)
        ctx.lineWidth = 1
        ctx.strokeStyle = C.faint
        ctx.strokeRect(x - 3.5, y - 3.5, 7, 7)
      } else {
        // the step now: bigger, in its agent's colour, with an outline that beats (and drains at a review)
        square(x, y, 11, one.lanes.length ? one.lanes : [loop.lane], false)
        const beat = 0.5 + 0.5 * Math.sin(at * Math.PI * 2 / 0.9)
        const ring = 17, half = ring / 2
        ctx.lineWidth = 1.5
        if (loop.left !== null) {
          ctx.strokeStyle = mix(C.amber, C.bg, 0.65)
          ctx.strokeRect(Math.round(x - half) + 0.5, Math.round(y - half) + 0.5, ring, ring)
          ctx.strokeStyle = C.amber
          ctx.setLineDash([ring * 4 * loop.left, ring * 4])
          ctx.strokeRect(Math.round(x - half) + 0.5, Math.round(y - half) + 0.5, ring, ring)
          ctx.setLineDash([])
        } else {
          ctx.strokeStyle = mix(C.bright, C.bg, 0.15 + 0.6 * (1 - beat))
          ctx.strokeRect(Math.round(x - half) + 0.5, Math.round(y - half) + 0.5, ring, ring)
        }
      }
    })
  }

  // inside the track: who near its top, what in small type below, and which step of how many
  // near its bottom. With no workflow (Claude on its own) there is no count and no step marks
  // on the sides, only one small square going round, so the words get that room: wider lines,
  // and five of them where a workflow has three over its count
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const cx = sx + side / 2
  const alone = !nodes.length
  const room = side - (alone ? 12 : 18)
  const fitText = (text: string) => {
    let out = text
    while (out.length > 1 && ctx.measureText(out).width > room) out = out.slice(0, -2) + '…'
    return out
  }
  const BOLD = `bold 10.5px ${MONO}`, SMALL = `9px ${MONO}`, FOOT = `bold 9.5px ${MONO}`
  ctx.font = BOLD
  ctx.fillStyle = gate ? C.amber : line.tone === 'work' ? lane : C.dim
  ctx.fillText(fitText(`${line.tone === 'work' ? spin(loop.lane, at) + ' ' : ''}${gate ? 'review' : loop.lane}`), cx, sy + (alone ? 13 : 17))

  // which step of how many, with the review's seconds or the step's count beside it when they fit
  const count = s.live && s.phase >= 0 ? `${s.phase + 1}/${s.phases.length}` : ''
  const extra = state?.flow.paused && !gate ? 'paused' : line.tail.trim()
  ctx.font = FOOT
  const both = count && extra ? `${count} ${extra}` : count || extra
  const foot = ctx.measureText(both).width <= room ? both : gate ? extra : count || extra

  ctx.font = SMALL
  const what = s.live && s.phase >= 0 ? (s.phases[s.phase] ?? '').toLowerCase() : line.main.toLowerCase()
  const wrapped: string[] = []
  for (const word of what.split(/\s+/).filter(Boolean)) {
    const last = wrapped[wrapped.length - 1]
    if (last !== undefined && ctx.measureText(`${last} ${word}`).width <= room) wrapped[wrapped.length - 1] = `${last} ${word}`
    else wrapped.push(word)
  }
  // three lines over the step count, four with no count, five with Claude on its own. More
  // words join the last line, which ends in … where it runs out
  const most = foot ? 3 : alone ? 5 : 4
  const shown = wrapped.slice(0, most)
  if (wrapped.length > most) shown[most - 1] = `${shown[most - 1]} ${wrapped.slice(most).join(' ')}`
  const LEAD = alone ? 10 : 11
  const middle = foot ? sy + 42 : sy + 45
  ctx.fillStyle = C.fg
  shown.forEach((text, i) => ctx.fillText(fitText(text), cx, middle + (i - (shown.length - 1) / 2) * LEAD + 0.5))

  ctx.font = FOOT
  if (foot) {
    ctx.fillStyle = gate || state?.flow.paused ? C.amber : C.dim
    ctx.fillText(fitText(foot), cx, sy + side - 17)
  }
  hots.push({ x: 0, y: top, w: TILE, h: TILE, run: () => act('open', s.gate) })

  if (open) {
    box(0, 0, TILE, ROW - 4)
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.font = `bold 11px ${MONO}`
    const words2: [string, 'approve' | 'pause' | 'open' | 'decline'][] = s.gate
      ? (s.gate.noAuto ? [['yes', 'approve'], ['no', 'decline'], ['open', 'open']] : [['ok', 'approve'], [state?.flow.paused ? '▶' : '||', 'pause'], ['open', 'open']])
      : s.live ? [[state?.flow.paused ? '▶' : '||', 'pause'], ['open', 'open']] : [['open', 'open']]
    const widths = words2.map(([word]) => ctx.measureText(`[${word}]`).width)
    const total = widths.reduce((a, b) => a + b, 0) + (words2.length - 1) * 5
    let bx = (TILE - total) / 2
    const ry = (ROW - 4) / 2 + 0.5
    words2.forEach(([word, kind], i) => {
      ctx.fillStyle = kind === 'approve' ? C.amber : C.dim
      ctx.fillText(`[${word}]`, bx, ry)
      const gateNow = s.gate
      hots.unshift({ x: bx - 2, y: 0, w: widths[i]! + 4, h: ROW - 4, run: () => act(kind, gateNow) })
      bx += widths[i]! + 5
    })
  }
}

// ---------------------------------------------------------------- drawn look: a hand-drawn ring

function pillSvg(w: number, h: number, key: string, gate: boolean): string {
  seedFrom(key)
  const fixed: [number, number] = [Math.max(2, Math.round(w / 46)), 2]
  const r = h / 2
  return `<svg class="ink" width="${w + 16}" height="${h + 16}" viewBox="-6 -6 ${w + 16} ${h + 16}" data-pos="left:-6px;top:-6px;z-index:-1">`
    + `<path d="${boxPath(2.2, 2.6, w, h, r, 0.4, fixed)}" fill="${INK}" fill-opacity="${gate ? 0.18 : 0.12}"/>`
    + `<path d="${boxPath(1, 1.2, w - 1.2, h - 1, r, 0.35, fixed)}" fill="${gate ? FILL.gold : FILL.sheet}"/>`
    + `<path d="${boxPath(0, 0, w, h, r, 0.7, fixed)}" fill="none" stroke="${INK}" stroke-width="1.4" stroke-linecap="round"/></svg>`
}

/** An arc of the ring, drawn by hand: a few wobbly points along the circle. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, key: string): string {
  seedFrom(key)
  const n = Math.max(2, Math.round(((a1 - a0) * r) / 5))
  let d = ''
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n
    const rr = r + (k > 0 && k < n ? j(0.35) : 0)
    d += `${k ? 'L' : 'M'}${(cx + Math.cos(a) * rr).toFixed(2)} ${(cy + Math.sin(a) * rr).toFixed(2)} `
  }
  return d
}

function ringSvg(at: number, loop: ReturnType<typeof loopFor>, line: Line): string {
  const S = 38, c = S / 2, R = 13.6, nr = 4.3
  const top = -Math.PI / 2
  let out = `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">`
  // the track: one hand-drawn circle the steps sit on
  out += `<path d="${arc(c, c, R, 0, Math.PI * 2, 'track')}" fill="none" stroke="${INK}" stroke-opacity=".45" stroke-width="1.1" stroke-linecap="round"/>`
  /** A step's circle, filled in its agents' washes (halves when two shared it). */
  const disc = (x: number, y: number, r: number, lanes: Lane[], key: string, stroke = 1.2) => {
    seedFrom(key)
    const ring = boxPath(x - r, y - r, r * 2, r * 2, r, 0.25)
    let d = ''
    if (lanes.length > 1) {
      d += `<path d="${ring}" fill="${FILL[lanes[0]!]}"/>`
      d += `<path d="M${x} ${y - r} A${r} ${r} 0 0 1 ${x} ${y + r} Z" fill="${FILL[lanes[1]!]}"/>`
    } else d += `<path d="${ring}" fill="${lanes.length ? FILL[lanes[0]!] : FILL.oat}"/>`
    return d + `<path d="${ring}" fill="none" stroke="${INK}" stroke-width="${stroke}"/>`
  }
  const nodes = loop.nodes
  if (!nodes.length) {
    // Claude alone: one circle going round the track while it works, resting at the top when it is ready
    const a = top + (line.tone === 'work' ? ((at * 0.45) % 1) * Math.PI * 2 : 0)
    out += disc(c + Math.cos(a) * R, c + Math.sin(a) * R, nr + 0.4, [loop.lane], 'solo')
  }
  if (nodes.length) {
    // which step it is, by motion: a stroke runs round from the first step to the one now, rests, and runs again
    const nowAt = Math.max(0, nodes.findIndex(one => one.state === 'now'))
    if (nowAt > 0) {
      const span = (nowAt * Math.PI * 2) / nodes.length
      const k = Math.min(1, (at % 2.4) / 1.3)
      const eased = 1 - Math.pow(1 - k, 3)
      const colour = loop.left !== null ? CLAY_UI : DEEP[loop.lane]
      out += `<path d="${arc(c, c, R, top, top + span, 'sweep-' + nowAt)}" pathLength="1" fill="none" stroke="${colour}" stroke-opacity=".75" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="${eased.toFixed(3)} 1"/>`
    }
  }
  nodes.forEach((one, i) => {
    const a = top + (i * Math.PI * 2) / nodes.length
    const x = c + Math.cos(a) * R, y = c + Math.sin(a) * R
    if (one.state === 'done') {
      out += disc(x, y, nr, one.lanes, `node-${i}`)
      out += `<path d="M${(x - 2).toFixed(2)} ${(y + 0.2).toFixed(2)} l1.4 1.5 l2.7 -3" fill="none" stroke="${INK}" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/>`
    } else if (one.state === 'next') {
      out += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${nr - 0.4}" fill="#fffdf8" stroke="#a39f95" stroke-width="1" stroke-dasharray="1.8 1.6"/>`
    } else {
      out += disc(x, y, nr + 0.9, one.lanes.length ? one.lanes : [loop.lane], `node-now-${i}`, 1.5)
      // the step now: a ring round it, turning while the step works, draining in clay at a review
      const rr = nr + 3.4
      if (loop.left !== null) {
        out += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${rr}" fill="none" stroke="#efe2c4" stroke-width="1.6"/>`
        out += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${rr}" pathLength="1" fill="none" stroke="${CLAY_UI}" stroke-width="1.6" stroke-dasharray="${loop.left.toFixed(3)} 1" transform="rotate(-90 ${x.toFixed(2)} ${y.toFixed(2)})"/>`
      } else if (loop.busy) {
        out += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${rr}" pathLength="1" fill="none" stroke="${INK}" stroke-width="1.3" stroke-dasharray="0.24 0.09" stroke-dashoffset="${(-(at * 0.35) % 1).toFixed(3)}"/>`
      }
    }
  })
  // inside: the seconds left at a review, else the agent's initial
  const inner = line.tone === 'gate' ? (line.tail === 'your yes' ? '?' : line.tail === 'paused' ? '||' : line.tail.replace('s', '')) : loop.lane === 'you' ? 'Y' : loop.lane === 'claude' ? 'C' : loop.lane === 'gemini' ? 'G' : 'X'
  out += `<text x="${c}" y="${c + 3.4}" text-anchor="middle" font-family="Literata, Georgia, serif" font-weight="700" font-size="${line.tone === 'gate' ? 9 : 9.5}" fill="${INK}">${esc(inner)}</text>`
  return out + '</svg>'
}

function btnHtml(word: string, kind: string) {
  seedFrom('cmp-btn' + word)
  const w = Math.round(word.length * 6 + 16), h = 20
  const fill = kind === 'approve' ? FILL.clay : FILL.sheet
  return `<button class="btn" data-act="${kind}" data-pos="width:${w}px"><svg class="ink" width="${w + 10}" height="${h + 10}" viewBox="-3 -3 ${w + 10} ${h + 10}" data-pos="left:-3px;top:-3px;z-index:-1"><path d="${boxPath(1.8, 2.2, w, h, 5, 0.4)}" fill="${INK}" fill-opacity=".14"/><path d="${boxPath(0.8, 1, w - 0.8, h - 0.8, 5, 0.3)}" fill="${fill}"/><path d="${boxPath(0, 0, w, h, 5, 0.6)}" fill="none" stroke="${INK}" stroke-width="1.2"/></svg>${esc(word)}</button>`
}

function drawDrawn(at: number) {
  const s = situation(at)
  const line = lineFor(at, s)
  const loop = loopFor(at, s, line)
  // always room for the row above the pill, so opening it moves nothing
  const h = H + ROW
  const top = ROW
  const gate = line.tone === 'gate'
  let html = `<div class="pill" data-act="open" data-pos="top:${top}px;width:${W}px;height:${H}px">${pillSvg(W, H, 'cmp-pill' + (gate ? 'g' : 's'), gate)}`
  html += `<span class="ring">${ringSvg(at, loop, line)}</span>`
  // the ring's initial says who and, at a review, how long is left: the line is all words for what
  const tail = (state?.flow.paused && !gate ? 'Paused ' : '') + (gate ? '' : line.tail)
  html += `<span class="line"><b>${esc(line.main)}</b></span>${tail ? `<span class="tail${state?.flow.paused ? ' hot' : ''}">${esc(tail)}</span>` : ''}</div>`
  if (open) {
    // the row is paper too, so it reads over any desktop
    html += `<div class="row" data-pos="top:0;height:${ROW - 4}px;width:${W}px">${pillSvg(W, ROW - 4, 'cmp-row', false)}`
    // the step's name, short when three buttons need the room
    const many = actionsFor(s).length >= 3
    if (s.live && s.phase >= 0) html += `<span class="phase">${s.phase + 1}/${s.phases.length}${many ? '' : ` · ${esc(s.phases[s.phase] ?? '')}`}</span>`
    else if (state?.claude && state.claude.state !== 'idle') {
      const secs = Math.floor(now() - state.claude.since)
      html += `<span class="phase">Working ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}</span>`
    }
    html += `<span class="sp"></span>${actionsFor(s).map(([word, kind]) => btnHtml(word, kind)).join('')}</div>`
  }
  drawnHost.style.width = `${W}px`
  drawnHost.style.height = `${h}px`
  if (html !== drawnKey) {
    drawnKey = html
    drawnHost.innerHTML = html
    // The CSP allows .style, not style attributes: positions travel in data-pos.
    drawnHost.querySelectorAll<HTMLElement | SVGElement>('[data-pos]').forEach(el => { el.style.cssText = (el as HTMLElement).dataset.pos ?? '' })
  }
}

// ---------------------------------------------------------------- wiring

bridge.on('companion', payload => {
  state = payload as State
  shell.classList.toggle('on', state.visible)
  shell.classList.toggle('cli', state.theme === 'cli')
  shell.classList.toggle('drawn', state.theme === 'drawn')
})

function loop() {
  if (state?.visible) {
    try {
      if (state.theme === 'cli') drawCli(now())
      else drawDrawn(now())
    } catch (error) {
      console.error(error)
    }
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

// Hover: the main process watches the pointer and says when the row opens or shuts. The window
// always has room for the row, so opening it resizes nothing (a resize made the bar flash).
bridge.on('companion-row', payload => {
  open = payload === true
})

// The bar redraws every frame, so a press acts at once (a click could fall between two drawings).
canvas.addEventListener('pointerdown', event => {
  const box = canvas.getBoundingClientRect()
  const x = event.clientX - box.left, y = event.clientY - box.top
  hots.find(h => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h)?.run()
})
drawnHost.addEventListener('pointerdown', event => {
  const el = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')
  if (!el?.dataset.act) return
  act(el.dataset.act as 'approve' | 'pause' | 'open' | 'decline', situation(now()).gate)
})
