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
  on(event: 'companion', listener: (payload: unknown) => void): () => void
  companionHover(isOver: boolean): Promise<void>
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

// ---------------------------------------------------------------- terminal look: a square loop

function drawCli(at: number) {
  const dpr = window.devicePixelRatio || 1
  const h = open ? H + ROW : H
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${W}px`
    canvas.style.height = `${h}px`
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, h)
  hots = []
  const s = situation(at)
  const line = lineFor(at, s)
  const loop = loopFor(at, s, line)
  const top = h - H

  // the window: a dark terminal pill
  const box = (x: number, y: number, w: number, hh: number) => { ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, hh - 1, 6); ctx.fillStyle = C.bg; ctx.fill(); ctx.strokeStyle = line.tone === 'gate' ? mix(C.amber, C.bg, 0.35) : C.rule; ctx.lineWidth = 1; ctx.stroke() }
  box(0, top, W, H)

  // the square loop: a square track with one small square per step on it
  const side = 26, sx = 7, sy = top + (H - side) / 2
  const per = side * 4
  const pointAt = (d: number): [number, number] => {
    const k = ((d % per) + per) % per
    if (k < side) return [sx + k, sy]
    if (k < side * 2) return [sx + side, sy + (k - side)]
    if (k < side * 3) return [sx + side - (k - side * 2), sy + side]
    return [sx, sy + side - (k - side * 3)]
  }
  const lane = C[loop.lane]
  ctx.strokeStyle = C.rule
  ctx.lineWidth = 1
  ctx.strokeRect(sx + 0.5, sy + 0.5, side, side)
  /** A step's square: filled in its agents' colours (split when two shared it). */
  const node = (x: number, y: number, size: number, lanes: Lane[], dim: boolean) => {
    const h0 = size / 2
    const colours = lanes.length ? lanes.map(one => (dim ? mix(C[one], C.bg, 0.35) : C[one])) : [C.dim]
    ctx.fillStyle = colours[0]!
    ctx.fillRect(x - h0, y - h0, size, size)
    if (colours[1]) { ctx.fillStyle = colours[1]; ctx.fillRect(x, y - h0, h0, size) }
  }
  const nodes = loop.nodes
  if (!nodes.length) {
    // Claude alone: one square going round the track while it works, resting at the top when it is ready
    const [x, y] = pointAt(side / 2 + (line.tone === 'work' ? (at * 40) % per : 0))
    node(x, y, 7, [loop.lane], line.tone !== 'work')
  }
  nodes.forEach((one, i) => {
    const [x, y] = pointAt(side / 2 + (i * per) / nodes.length)
    if (one.state === 'done') node(x, y, 6, one.lanes, true)
    else if (one.state === 'next') {
      ctx.fillStyle = C.bg
      ctx.fillRect(x - 3, y - 3, 6, 6)
      ctx.lineWidth = 1
      ctx.strokeStyle = C.faint
      ctx.strokeRect(x - 2.5, y - 2.5, 5, 5)
    } else {
      node(x, y, 8, one.lanes.length ? one.lanes : [loop.lane], false)
      // the step now: an outline round it, running while the step works, draining at a review
      const ring = 13, h0 = ring / 2
      ctx.lineWidth = 1.5
      if (loop.left !== null) {
        ctx.strokeStyle = mix(C.amber, C.bg, 0.6)
        ctx.strokeRect(x - h0, y - h0, ring, ring)
        ctx.strokeStyle = C.amber
        ctx.setLineDash([ring * 4 * loop.left, ring * 4])
        ctx.strokeRect(x - h0, y - h0, ring, ring)
      } else if (loop.busy) {
        ctx.strokeStyle = C.bright
        ctx.setLineDash([5, 3])
        ctx.lineDashOffset = -at * 18
        ctx.strokeRect(x - h0, y - h0, ring, ring)
      }
      ctx.setLineDash([])
      ctx.lineDashOffset = 0
    }
  })
  // inside the square: the seconds left at a review, else the agent's spinner
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const mid: [number, number] = [sx + side / 2 + 0.5, sy + side / 2 + 1]
  if (line.tone === 'gate') {
    ctx.font = `bold 10px ${MONO}`
    ctx.fillStyle = C.amber
    ctx.fillText(line.tail === 'your yes' ? '?' : line.tail === 'paused' ? '||' : line.tail.replace('s', ''), ...mid)
  } else {
    ctx.font = `bold 11px ${MONO}`
    ctx.fillStyle = line.tone === 'work' ? lane : C.dim
    ctx.fillText(line.tone === 'work' ? spin(loop.lane, at) : '·', ...mid)
  }

  // the line: who, then what, then a short tail
  ctx.textAlign = 'left'
  ctx.font = `12px ${MONO}`
  // the loop's colour and spinner already say who: the line is all words for what
  const x = 46
  const room = W - 10
  const y = top + H / 2 + 0.5
  // at a review the seconds are inside the loop, so the line does not repeat them
  const tail = (state?.flow.paused && line.tone !== 'gate' ? 'paused ' : '') + (line.tone === 'gate' ? '' : line.tail)
  ctx.font = `bold 12px ${MONO}`
  const tailW = tail ? ctx.measureText(tail).width + 8 : 0
  ctx.font = `12px ${MONO}`
  let main = line.main
  while (main.length > 1 && ctx.measureText(main).width > room - x - tailW) main = main.slice(0, -2) + '…'
  ctx.fillStyle = line.tone === 'gate' ? C.amber : line.tone === 'work' ? mix(C[line.who ?? 'claude'], C.bright, 0.35) : C.dim
  ctx.fillText(main, x, y)
  if (tail) {
    ctx.font = `bold 12px ${MONO}`
    ctx.fillStyle = line.tone === 'gate' || state?.flow.paused ? C.amber : C.dim
    ctx.fillText(tail, room - tailW + 8, y)
  }
  hots.push({ x: 0, y: top, w: W, h: H, run: () => act('open', s.gate) })

  if (open) {
    box(0, 0, W, ROW - 4)
    ctx.font = `12px ${MONO}`
    ctx.textBaseline = 'middle'
    const ry = (ROW - 4) / 2 + 0.5
    let bx = W - 8
    const actions = actionsFor(s)
    ctx.font = `bold 12px ${MONO}`
    const buttonsW = actions.reduce((sum, [word]) => sum + ctx.measureText(`[${word.toLowerCase()}]`).width + 8, 0)
    ctx.font = `12px ${MONO}`
    // the step's name, as long as it fits beside the buttons
    const label = s.live && s.phase >= 0
      ? `${s.phase + 1}/${s.phases.length} ${(s.phases[s.phase] ?? '').toLowerCase()}`
      : state?.claude && state.claude.state !== 'idle' ? `working ${Math.floor((now() - state.claude.since) / 60)}:${String(Math.floor(now() - state.claude.since) % 60).padStart(2, '0')}` : ''
    const short = s.live && s.phase >= 0 ? `${s.phase + 1}/${s.phases.length}` : label
    const fits = (text: string) => 10 + ctx.measureText(text).width + 10 <= W - 8 - buttonsW
    const shown = fits(label) ? label : fits(short) ? short : ''
    if (shown) { ctx.fillStyle = C.dim; ctx.fillText(shown, 10, ry) }
    for (const [word, kind] of actions.reverse()) {
      const text = `[${word.toLowerCase()}]`
      ctx.font = `bold 12px ${MONO}`
      const w = ctx.measureText(text).width
      bx -= w
      ctx.fillStyle = kind === 'approve' ? C.amber : C.dim
      ctx.fillText(text, bx, ry)
      const gate = s.gate
      hots.unshift({ x: bx - 2, y: 0, w: w + 4, h: ROW - 4, run: () => act(kind, gate) })
      bx -= 8
    }
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
  const h = open ? H + ROW : H
  const top = h - H
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

// Hover: the window grows upward first, then the small row opens in the new room.
let leaveTimer: number | undefined
shell.addEventListener('mouseenter', () => {
  window.clearTimeout(leaveTimer)
  if (open) return
  void bridge.companionHover(true).then(() => { open = true })
})
shell.addEventListener('mouseleave', () => {
  leaveTimer = window.setTimeout(() => {
    open = false
    void bridge.companionHover(false)
  }, 350)
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
