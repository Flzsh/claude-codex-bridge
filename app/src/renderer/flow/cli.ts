// The CLI theme: the flow drawn the way a terminal program draws it, on a
// cell grid. Left pane: the flow as a git-style graph, one column per agent,
// with whatever is working highlighted and live. Right pane: the selected
// step, an agent's window (1:claude 2:gemini 3:codex), or the settings.
// Bottom: the steer box and a tmux-style status bar. Every frame is drawn
// from the clock and the events alone.

import { stagesFor, type Size } from '../../../../core/console'
import { graphCell, layout, LANE, LANES, GAP, type Lane, type Step } from '../../../../core/flow'
import { gateLeft, gateOptions, type Flow, type Frame, type Pane } from './controller'
import { JOIN, Term } from './term'
import { C, clock, EIGHTHS, elapsed, fit, LINE, mix, shimmer, spin, took } from './termkit'

/** Seconds a notice under the box stays. */
const NOTICE_S = 6

type Hot = { x: number; y: number; w: number; run: () => void; step?: string }
type Graph = ReturnType<typeof layout>
type FlowLine = Graph['lines'][number]
type Live = Step & { tNode?: number; path?: [number, number][] }

const WINDOWS: { pane: Pane; name: string }[] = [
  { pane: 'detail', name: 'step' },
  { pane: 'claude', name: 'claude' },
  { pane: 'gemini', name: 'gemini' },
  { pane: 'codex', name: 'codex' },
  { pane: 'settings', name: 'settings' },
]

export class CliView {
  private readonly canvas: HTMLCanvasElement
  private readonly field: HTMLTextAreaElement
  private readonly term: Term
  private hots: Hot[] = []
  /** Lines scrolled back from the newest (0 follows the flow). */
  private back = 0
  private lastRows: { id: string; y: number }[] = []
  private graph: Graph | null = null
  private graphFor: Map<string, Step> | null = null
  private readonly off: (() => void)[] = []

  constructor(private readonly root: HTMLElement, private readonly flow: Flow) {
    root.classList.add('theme-cli')
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'cli-screen'
    // The steer box's real text field: invisible, kept over the drawn box so typing and IME work.
    this.field = document.createElement('textarea')
    this.field.className = 'cli-field'
    this.field.spellcheck = false
    this.field.setAttribute('aria-label', 'Steer the work')
    root.append(this.canvas, this.field)
    this.term = new Term(this.canvas, { bg: C.bg, fg: C.fg })
    this.field.value = flow.input
    this.wire()
    this.field.focus()
  }

  destroy() {
    for (const off of this.off) off()
    this.root.classList.remove('theme-cli')
    this.canvas.remove()
    this.field.remove()
  }

  // ---------------------------------------------------------------- input

  private wire() {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (event: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(type, fn as EventListener)
      this.off.push(() => el.removeEventListener(type, fn as EventListener))
    }
    on(this.field, 'input', () => this.flow.typed(this.field.value.replace(/\n/g, ' '), this.flow.frame().gate))
    on(this.field, 'keydown', event => this.key(event))
    on(this.canvas, 'mousemove', event => {
      const hot = this.hotAt(event)
      this.flow.hover = hot?.step ?? null
      this.canvas.style.cursor = hot ? 'pointer' : 'default'
    })
    on(this.canvas, 'mouseleave', () => { this.flow.hover = null })
    on(this.canvas, 'click', event => {
      this.hotAt(event)?.run()
      this.field.focus()
    })
    on(this.canvas, 'wheel', event => {
      this.back = Math.max(0, this.back + Math.sign(event.deltaY) * -3)
    })
    on(window, 'focus', () => this.field.focus())
  }

  private hotAt(event: MouseEvent): Hot | undefined {
    const box = this.canvas.getBoundingClientRect()
    const cell = this.term.at(event.clientX - box.left, event.clientY - box.top)
    if (!cell) return undefined
    return this.hots.find(h => h.y === cell.y && cell.x >= h.x && cell.x < h.x + h.w)
  }

  private key(event: KeyboardEvent) {
    const flow = this.flow
    const frame = flow.frame()
    const gate = frame.gate
    const empty = flow.input.trim() === ''
    const ctrl = event.ctrlKey || event.metaKey
    if (ctrl && event.key.toLowerCase() === 'p') { event.preventDefault(); void flow.togglePause(); return }
    if (ctrl && event.key.toLowerCase() === 't') { event.preventDefault(); void flow.setTheme('drawn'); return }
    if (ctrl && event.key === ',') { event.preventDefault(); flow.setPane('settings'); return }
    if ((ctrl || event.altKey) && /^[0-4]$/.test(event.key)) { event.preventDefault(); flow.setPane(WINDOWS[Number(event.key)]!.pane); return }
    if (event.key === 'Tab') { event.preventDefault(); flow.cycleTarget(); this.field.value = flow.input; return }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (!empty) { void flow.send(gate); this.field.value = ''; return }
      // nothing is answered until the owner has moved to an answer with the arrows (or clicked one)
      if (gate && flow.choice >= 0) this.choose(gate, gateOptions(gate, flow.paused)[flow.choice]?.answer)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!empty) { flow.input = ''; this.field.value = ''; void flow.release() }
      else if (flow.pinned) flow.select(null)
      else if (flow.pane !== 'detail') flow.setPane('detail')
      return
    }
    if (!empty) return
    if (gate && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      const count = gateOptions(gate, flow.paused).length
      flow.choice = flow.choice < 0 ? (event.key === 'ArrowRight' ? 0 : count - 1) : (flow.choice + (event.key === 'ArrowRight' ? 1 : count - 1)) % count
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const rows = this.lastRows
      if (!rows.length) return
      const at = rows.findIndex(r => r.id === (flow.pinned ?? frame.focusId))
      const next = at < 0 ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))
      const id = rows[next]!.id
      if (id !== flow.pinned) flow.select(id)
    }
  }

  private choose(gate: Step, answer: string | undefined) {
    if (answer === 'approve' || answer === 'decline') void this.flow.answer(gate, answer)
    else if (answer === 'pause') void this.flow.togglePause()
    else if (answer === 'focus') { this.field.focus(); void this.flow.holdForSteer(gate) }
  }

  // ---------------------------------------------------------------- draw

  render() {
    const term = this.term
    term.resize()
    term.clear()
    this.hots = []
    const flow = this.flow
    const frame = flow.frame()
    const { cols, rows } = term
    const t = frame.now
    const DW = cols >= 120 ? Math.max(42, Math.min(76, Math.round(cols * 0.36))) : Math.max(34, Math.round(cols * 0.4))
    const W1 = cols - DW
    const paneBottom = rows - 6
    this.drawFlow(frame, W1, paneBottom)
    this.drawSide(frame, W1, cols - W1, paneBottom)
    this.drawPrompt(frame, rows)
    this.drawStatus(frame, rows)
    term.paint()
    // The text field sits over the drawn steer box, so the IME window opens there.
    const by = rows - 5
    this.field.style.left = `${term.ox + 4 * term.cw}px`
    this.field.style.top = `${term.oy + (by + 1) * term.ch}px`
    this.field.style.width = `${Math.max(10, (cols - 16) * term.cw)}px`
    this.field.style.height = `${term.ch}px`
    if (this.field.value !== flow.input) this.field.value = flow.input
  }

  private phases(): string[] {
    const size = (this.flow.info?.size ?? 'large') as Size
    return stagesFor(['small', 'medium', 'large'].includes(size) ? size : 'large').map(stage => stage.label.toLowerCase())
  }

  private drawFlow(frame: Frame, W1: number, paneBottom: number) {
    const term = this.term
    const flow = this.flow
    const t = frame.now
    const right = W1 - 2
    const gx = 4
    const textX = gx + 3 * GAP + 5
    const phases = this.phases()

    term.box(0, 0, W1, paneBottom + 1, C.rule)
    const tx = term.put(2, 0, ' flow ', C.fg, { b: true })
    const title = flow.settings?.workdir ? (flow.info ? flow.info.title : 'no workflow yet') : 'no folder'
    term.put(tx + 1, 0, ` ${fit(title, right - tx - 22)} `, C.dim)
    if (flow.info?.size) {
      const label = ` ${flow.info.size} · ${phases.length} steps `
      term.put(W1 - 2 - label.length, 0, label, C.dim)
    }
    LANES.forEach((name, i) => term.put(gx + i * GAP - (name.length > 3 ? 2 : 1), 1, name, C[name], { b: true }))

    // live activity under each lane name: flat when idle, moving while that agent works
    const BARS = ' ▁▂▃▄▅▆▇█'
    const all = [...frame.steps.values()]
    LANES.forEach((name, i) => {
      const mine = all.filter(s => s.lane === name && s.kind !== 'gate' && s.kind !== 'steer')
      for (let k = 0; k < 7; k++) {
        const ts = t - (6 - k) * 0.16
        const busy = mine.some(s => s.t0 <= ts && (s.t1 === undefined || s.t1 > ts))
        let level = 0
        if (busy) {
          level = 0.3 + 0.32 * (0.5 + 0.5 * Math.sin(ts * 7.3 + i * 1.7)) * (0.6 + 0.4 * Math.sin(ts * 2.9 + k))
          const recent = this.flow.events.some(e => e.t <= ts && e.t > ts - 0.3 && e.id !== undefined && frame.steps.get(e.id)?.lane === name)
          if (recent) level += 0.22
        }
        const ch = busy ? (BARS[Math.max(1, Math.min(8, Math.round(level * 8)))] ?? '▁') : '▁'
        term.put(gx + i * GAP - 3 + k, 2, ch, busy ? mix(C[name], C.bright, Math.min(0.5, level * 0.3)) : C.rule)
      }
    })

    if (!flow.settings?.workdir) {
      const x = term.put(textX, 4, ' pick a folder ', C.claude, { b: true })
      this.hots.push({ x: textX, y: 4, w: x - textX, run: () => void flow.api.pickFolder() })
      return
    }
    if (!flow.info) {
      // how it starts, and whether Claude Code is there to start it
      const room = Math.max(20, right - textX - 1)
      /** Words laid into lines of the room's width, from row y; the next free row back. */
      const para = (text: string, y: number, color: string, x = textX, width = room) => {
        let line = ''
        for (const word of text.split(' ')) {
          if (line && line.length + 1 + word.length > width) { term.put(x, y++, line, color); line = word }
          else line = line ? `${line} ${word}` : word
        }
        if (line) term.put(x, y++, line, color)
        return y
      }
      term.put(textX, 4, 'no workflow yet', C.fg, { b: true })
      let y = para('type what it should do in the box below and press enter. claude sizes it and plans it, gemini and codex join, and each step shows here. it stops at a review for you.', 6, C.dim)
      y = para('during a workflow the box steers claude: it reads your note at its next step. @codex or @gemini asks one directly.', y + 1, C.faint)
      const here = flow.settings?.claudeHere === true
      term.put(textX, y + 1, here ? '●' : '○', here ? C.green : C.amber)
      para(here ? 'claude code is open in this folder' : 'no claude code session in this folder yet: open one here first', y + 1, here ? C.dim : C.amber, textX + 2, room - 2)
      return
    }

    // the graph is worked out again only when the steps changed
    if (this.graphFor !== frame.steps) { this.graph = layout(frame.steps); this.graphFor = frame.steps }
    const graph = this.graph!
    const lines = graph.lines
    const first = 3, room = paneBottom - first
    const bottom = Math.max(0, lines.length - room)
    this.back = Math.min(this.back, bottom)
    const scroll = bottom - this.back
    this.lastRows = []
    const focusId = frame.focusId

    const nodeOf = (s: Step) => (s as Live).tNode ?? s.t0
    for (let i = scroll; i < lines.length && i - scroll < room; i++) {
      const line = lines[i]!
      const y = first + i - scroll
      const step = 'step' in line ? (line.step as Step | undefined) : undefined
      if (line.kind === 'step' && step) {
        this.lastRows.push({ id: step.id, y })
        const id = step.id
        this.hots.push({ x: 1, y, w: W1 - 2, run: () => flow.select(id), step: id })
      }
      const shown = line.kind === 'step' && step && t >= nodeOf(step)
      if (shown && step && step.state === 'running') {
        // the working highlight: a tint in the agent's colour with a band sweeping through it
        const lane = C[step.lane]
        const base = mix(C.bg, lane, step.id === focusId ? 0.16 : 0.11)
        const peak = mix(C.bg, lane, 0.34)
        const centre = (((t - nodeOf(step)) * 70) % (W1 + 30)) - 15
        for (let x = 1; x < W1 - 1; x++) {
          const k = Math.max(0, 1 - Math.abs(x - centre) / 14)
          term.shade(x, y, 1, mix(base, peak, k * k))
        }
      } else if (shown && step && step.id === focusId) term.shade(1, y, W1 - 2, C.sel)
      else if (shown && step && step.id === flow.hover) term.shade(1, y, W1 - 2, C.hover)
      for (let x = 0; x <= 3 * GAP; x++) {
        const g = graphCell(line, x, t)
        if (g) term.put(gx + x, y, JOIN[g.bits] ?? '┼', LINE[g.lane as Lane] ?? C.dim)
      }
      if (line.kind === 'head') this.drawHead(line, y, t, textX, right, phases)
      else if (step && line.kind === 'step') this.drawStep(step, y, t, gx, textX, right, graph, i)
      else if (step && line.kind === 'prompt') this.drawGatePrompt(step, y, t, textX, right)
      else if (step && line.kind === 'count') this.drawCount(step, y, t, textX)
      else if (step && line.kind === 'live') this.drawLive(step, y, t, textX, right)
    }

    // a pulse runs down the line into each working step
    for (const s of frame.steps.values()) {
      const live = s as Live
      if (s.state !== 'running' || !live.path || t < nodeOf(s)) continue
      const len = live.path.length, period = len + 14
      const head = Math.floor((t - nodeOf(s)) / 0.045) % period
      for (let k = 0; k < 3; k++) {
        const at = live.path[head - k]
        if (!at) continue
        const y = first + at[0] - scroll
        if (y < first || y >= paneBottom) continue
        const cell = term.cell(gx + at[1], y)
        if (cell && cell.c !== ' ') cell.fg = mix(C[s.lane], C.bright, [0.85, 0.45, 0.2][k] ?? 0)
      }
    }
    if (this.back > 0) {
      const label = ` ↓ ${this.back} newer `
      term.put(right - label.length, paneBottom, label, C.amber)
      this.hots.push({ x: right - label.length, y: paneBottom, w: label.length, run: () => { this.back = 0 } })
    }
  }

  private drawHead(line: FlowLine, y: number, t: number, textX: number, right: number, phases: string[]) {
    const term = this.term
    const phase = 'phase' in line && typeof line.phase === 'number' ? line.phase : 0
    const k = (t - line.t0) * 260
    if (k <= 0) return
    const max = Math.min(right, textX + k)
    let x = term.put(textX, y, `${phase + 1}/${phases.length}`, C.faint, { max })
    x = term.put(x + 1, y, phases[phase] ?? '', C.dim, { max })
    term.put(x + 1, y, '╌'.repeat(Math.max(0, right - x - 1)), C.rule, { max })
  }

  private drawStep(s: Step, y: number, t: number, gx: number, textX: number, right: number, graph: Graph, index: number) {
    const term = this.term
    const tNode = (s as Live).tNode ?? s.t0
    if (t < tNode) return
    const lx = gx + LANE[s.lane] * GAP
    const live = s.state === 'running' || s.state === 'waiting'
    const since = t - tNode
    let node = '●', nodeColor: string = C[s.lane]
    if (s.state === 'running') node = spin(s.lane, t)
    if (s.state === 'waiting') { node = '◉'; nodeColor = mix(C.amber, C.bg, (Math.sin(t * 5) + 1) * 0.22) }
    if (s.state === 'failed') { node = '✗'; nodeColor = C.red }
    if (s.kind === 'steer') node = '◇'
    term.put(lx, y, node, nodeColor, { b: true })
    // a steer points at the agent it went to
    if (s.kind === 'steer' && s.to && s.to in LANE) {
      const to = gx + LANE[s.to as Lane] * GAP
      const n = Math.min(to - lx - 1, Math.floor(since / 0.012))
      const line = graph.lines[index]
      for (let x = lx + 1; x <= lx + n; x++) {
        if (line && graphCell(line, x - gx, t)) continue
        term.put(x, y, x === to - 1 ? '▸' : '╌', C.you)
      }
    }
    const max = Math.min(right - 7, textX + Math.floor(since * 700))
    const flash = s.t1 !== undefined ? Math.max(0, 1 - (t - s.t1) / 0.6) : 0
    term.put(textX, y, s.lane, C[s.lane], { max })
    const title = s.title ?? ''
    const titleColor = s.state === 'waiting' ? C.amber : live ? shimmer(C.fg, t, title.length) : mix(C.fg, C.bright, flash)
    const x = term.put(textX + 8, y, fit(title, right - textX - 20), titleColor, { max, b: live || flash > 0.3 })
    const words = s.state === 'running' ? s.words : s.summary
    if (words) {
      const fresh = live ? Math.max(0, 1 - (t - (s.tWords ?? s.t0)) / 0.5) : 0
      const column = right - 8 - (textX + 32) >= 34 ? textX + 32 : 0
      const wx = Math.max(x + 3, column)
      term.put(wx, y, fit(words, right - 8 - wx), mix(C.dim, C.fg, fresh), { max })
    }
    let tail = '', tailColor: string = C.dim
    const left = s.kind === 'gate' && s.state === 'waiting' ? gateLeft(s, t) : null
    if (s.state === 'running') { tail = elapsed(t - s.t0); tailColor = C.faint }
    else if (s.state === 'waiting' && left !== null) { tail = `${left}s`; tailColor = C.amber }
    else if (s.state === 'waiting') { tail = s.paused ? 'paused' : 'your call'; tailColor = C.amber }
    else if (s.auto && typeof s.wait === 'number') tail = took(s.wait)
    else if (s.t1 !== undefined && s.kind !== 'steer' && s.t1 - s.t0 >= 1) tail = took(s.t1 - s.t0)
    if (tail && since > 0.15) term.put(right - tail.length, y, tail, tailColor, { b: s.state === 'waiting' })
  }

  private drawGatePrompt(s: Step, y: number, t: number, textX: number, right: number) {
    const term = this.term
    const flow = this.flow
    const tNode = (s as Live).tNode ?? s.t0
    if (t < tNode) return
    const max = Math.min(right, textX + Math.floor((t - tNode) * 700))
    if (s.state === 'waiting') {
      let x = term.put(textX, y, '?', C.amber, { b: true, max })
      x = term.put(x + 1, y, fit(`${s.title ?? 'review'}?`, 30), C.bright, { b: true, max })
      x += 2
      gateOptions(s, flow.paused).forEach((option, i) => {
        const chosen = i === flow.choice
        const start = x
        if (chosen) { term.put(x, y, '❯', C.amber, { b: true, max }); x += 2 }
        x = term.put(x, y, option.word, chosen ? C.amber : option.word === 'decline' || option.word === 'not now' ? mix(C.red, C.bg, 0.25) : C.dim, { u: chosen, b: chosen, max })
        const answer = option.answer
        this.hots.push({ x: start, y, w: x - start, run: () => { flow.choice = i; this.choose(s, answer) } })
        x += 3
      })
      if (s.noAuto) term.put(right - 'no auto-continue'.length, y, 'no auto-continue', C.faint, { max: right })
      else if (s.paused) term.put(right - 'paused'.length, y, 'paused', C.amber, { max: right })
    } else {
      const x = term.put(textX, y, s.state === 'failed' ? '✗' : '✓', s.state === 'failed' ? C.red : C.green, { max })
      const words = s.auto ? `nobody answered in ${s.wait ?? 30} s, so it carried on` : s.summary ?? (s.state === 'failed' ? 'declined' : 'approved')
      term.put(x + 1, y, fit(words, right - x - 2), C.dim, { max })
    }
  }


  private drawCount(s: Step, y: number, t: number, textX: number) {
    const term = this.term
    const tNode = (s as Live).tNode ?? s.t0
    if (t < tNode) return
    // paused: the countdown stops (flow.sh drops `until` until the owner resumes)
    if (typeof s.until !== 'number' || typeof s.wait !== 'number') { term.put(textX + 2, y, '⏸ paused', C.amber, { b: true }); return }
    const total = 36
    const shown = Math.min(total, Math.floor((t - tNode) * 240))
    const f = Math.max(0, Math.min(1, (s.until - t) / s.wait))
    const cells = f * total
    const full = Math.floor(cells), part = Math.floor((cells - full) * 8)
    const bx = textX + 2
    term.put(bx - 1, y, '▕', C.faint)
    for (let i = 0; i < shown; i++) {
      const ch = i < full ? '█' : i === full && part > 0 ? (EIGHTHS[part] ?? ' ') : '·'
      term.put(bx + i, y, ch, i <= full ? mix(C.amber, C.claude, i / total) : C.rule)
    }
    if (shown === total) {
      term.put(bx + total, y, '▏', C.faint)
      const x = term.put(bx + total + 2, y, 'carries on in ', C.dim)
      term.put(x, y, `${gateLeft(s, t) ?? 0}s`, C.amber, { b: true })
    }
  }

  private drawLive(s: Step, y: number, t: number, textX: number, right: number) {
    const term = this.term
    const tNode = (s as Live).tNode ?? s.t0
    if (t < tNode) return
    const max = Math.min(right, textX + Math.floor((t - tNode) * 700))
    let x = term.put(textX + 8, y, '⎿', C.faint, { max })
    const meterW = 16, bx = right - 30
    if (s.action) {
      const typed = Math.floor((t - Math.max(s.tAction ?? 0, tNode)) * 90)
      term.put(x + 2, y, '●', C[s.lane], { max })
      const [verb = '', ...rest] = s.action.split(' ')
      const room = bx - 3 - (x + 4)
      const text = fit(rest.join(' '), Math.max(0, room - verb.length - 1))
      const vx = term.put(x + 4, y, verb, C.fg, { b: true, max: Math.min(max, x + 4 + typed) })
      x = term.put(vx + 1, y, text, C.dim, { max: Math.min(max, x + 4 + typed) })
      if (s.result && x + 4 + s.result.length < bx - 2) term.put(x + 2, y, s.result, C.faint, { max: Math.min(max, x + 2 + Math.floor((t - (s.tResult ?? 0)) * 90)) })
    }
    // the meter: a count fills it; an open-ended count bounces a block along it
    term.put(bx - 1, y, '▕', C.faint, { max })
    const lane = C[s.lane]
    const [n, of, unit] = s.meter ?? [null, null, '']
    if (of && n !== null) {
      const cells = (n / of) * meterW
      const full = Math.floor(cells), part = Math.floor((cells - full) * 8)
      for (let i = 0; i < meterW; i++) {
        const ch = i < full ? '█' : i === full && part > 0 ? (EIGHTHS[part] ?? ' ') : '·'
        term.put(bx + i, y, ch, i <= full ? mix(lane, C.bright, 0.15 * (1 - i / meterW)) : C.rule, { max })
      }
    } else {
      const ping = ((t - tNode) * 0.75) % 2, pos = ping < 1 ? ping : 2 - ping
      const centre = pos * (meterW - 1)
      for (let i = 0; i < meterW; i++) {
        const d = Math.abs(i - centre)
        const ch = d < 0.6 ? '█' : d < 1.6 ? '▓' : d < 2.6 ? '▒' : d < 3.6 ? '░' : '·'
        term.put(bx + i, y, ch, ch === '·' ? C.rule : lane, { max })
      }
    }
    term.put(bx + meterW, y, '▏', C.faint, { max })
    if (n !== null) {
      const label = of ? `${n}/${of} ${unit}` : `${n} ${unit}`
      const fresh = Math.max(0, 1 - (t - (s.tMeter ?? 0)) / 0.4)
      term.put(bx + meterW + 2, y, fit(label, right - bx - meterW - 2), mix(C.dim, C.bright, fresh), { max })
    }
  }

  // ---------------------------------------------------------------- right pane

  private drawSide(frame: Frame, DX: number, DW: number, paneBottom: number) {
    const term = this.term
    const flow = this.flow
    term.box(DX, 0, DW, paneBottom + 1, C.rule)
    if (flow.pane === 'settings') return this.drawSettings(DX, DW, paneBottom)
    if (flow.pane === 'claude' || flow.pane === 'gemini' || flow.pane === 'codex') return this.drawAgent(frame, flow.pane, DX, DW, paneBottom)
    const s = frame.focusId ? frame.steps.get(frame.focusId) : undefined
    if (!s) { term.put(DX + 2, 0, ' detail ', C.dim); return }
    this.drawDetail(frame, s, DX, DW, paneBottom)
  }

  private wrap(text: string, width: number): string[] {
    const out: string[] = []
    for (const para of text.split('\n')) {
      let line = ''
      for (const word of para.split(' ')) {
        if (word.length > width) { if (line) out.push(line); out.push(word.slice(0, width)); line = ''; continue }
        if ((line ? line + ' ' + word : word).length > width) { out.push(line); line = word }
        else line = line ? line + ' ' + word : word
      }
      out.push(line)
    }
    return out
  }

  private drawDetail(frame: Frame, s: Step, DX: number, DW: number, paneBottom: number) {
    const term = this.term
    const flow = this.flow
    const t = frame.now
    const win = { claude: 1, gemini: 2, codex: 3, you: 0 }[s.lane]
    const x = term.put(DX + 2, 0, win ? ` ${win}:${s.lane} ` : ' you ', C[s.lane], { b: true })
    term.put(x, 0, fit(s.title ?? '', DW - (x - DX) - 16) + ' ', C.dim)
    const tail = s.state === 'running' ? ` running ${elapsed(t - s.t0)} ` : s.state === 'waiting' ? ' waiting ' : s.t1 !== undefined ? ` done ${took(s.t1 - s.t0)} ` : ''
    if (tail) term.put(DX + DW - 2 - tail.length, 0, tail, s.state === 'waiting' ? C.amber : C.dim)
    const L0 = DX + 2, R0 = DX + DW - 2
    const since = t - Math.max(frame.focusSince, s.t0)
    const lineOk = (n: number) => since > n * 0.02
    let y = 2
    // tabs
    const tabs: [typeof flow.tab, string][] = [['progress', s.kind === 'gate' ? 'review' : 'progress'], ['brief', 'brief'], ['result', 'result']]
    let tx = L0
    for (const [tab, word] of tabs) {
      const on = flow.tab === tab
      const start = tx
      tx = term.put(tx, y, word, on ? C.bright : C.dim, { u: on, b: on })
      this.hots.push({ x: start, y, w: tx - start, run: () => flow.setTab(tab) })
      tx += 3
    }
    if (flow.pinned) {
      const back = 'follow live'
      term.put(R0 - back.length, y, back, C.amber)
      this.hots.push({ x: R0 - back.length, y, w: back.length, run: () => flow.select(null) })
    }
    y += 2
    const room = paneBottom - 1
    if (flow.tab !== 'progress') {
      const run = flow.runDetail(s.run)
      let text = ''
      if (flow.tab === 'brief') text = run?.brief || s.logs.filter(e => e.mark === '>').map(e => e.text).join('\n\n') || (s.run && !run ? 'loading…' : 'no brief')
      else text = run?.reply || s.summary || (s.run && !run ? 'loading…' : s.state === 'running' ? 'not done yet' : 'no result')
      for (const line of this.wrap(text, R0 - L0)) {
        if (y >= room) { term.put(L0, room, '…', C.faint); break }
        term.put(L0, y++, line, C.fg)
      }
      return
    }
    let n = 2
    let point = 0
    for (const entry of s.logs) {
      if (entry.t > t || y >= room) continue
      n++
      if (!lineOk(n)) break
      const typed = Math.max(0, Math.floor((t - entry.t) * 900))
      const k = Math.max(0, Math.min(1, (t - entry.t) / 0.5))
      const text = entry.text
      const put = (px: number, part: string, color: string, extra: { b?: boolean } = {}) => term.put(px, y, part, color, { max: Math.min(R0, px + typed), ...extra })
      if (entry.mark === '>') {
        for (const [i, part] of this.wrap(text, R0 - L0 - 2).entries()) {
          if (y >= room) break
          if (i === 0) term.put(L0, y, '>', C.dim)
          put(L0 + 2, part, C.fg)
          y++
        }
      } else if (entry.mark === '●') {
        term.put(L0, y, '●', C[s.lane])
        const [verb = '', ...rest] = text.split(' ')
        const vx = put(L0 + 2, verb, C.bright, { b: true })
        term.put(vx + 1, y, fit(rest.join(' '), R0 - vx - 1), C.fg, { max: Math.min(R0, L0 + 2 + typed) })
        y++
      } else if (entry.mark === '⎿') {
        term.put(L0 + 2, y, '⎿', C.faint)
        term.put(L0 + 5, y, fit(text, R0 - L0 - 5), mix(C.fg, C.dim, k), { max: Math.min(R0, L0 + 5 + typed) })
        y++
      } else if (entry.mark === '✻') {
        term.put(L0, y, '✻', C[s.lane])
        for (const part of this.wrap(text, R0 - L0 - 2)) {
          if (y >= room) break
          put(L0 + 2, part, mix(C.bright, C.dim, k * 0.6))
          y++
        }
      } else if (entry.mark === '✓') {
        term.put(L0, y, '✓', C.green, { b: true })
        put(L0 + 2, fit(text, R0 - L0 - 2), C.fg)
        y++
      } else if (entry.mark === '#') {
        point++
        // a point may come already numbered ("  1  text"); a point that starts with a number ("30 s, …") keeps it
        const [words = '', from = ''] = text.replace(/^\s*\d{1,2}\s{2,}/, '').split('|')
        term.put(L0, y, String(point).padStart(2), C.faint)
        put(L0 + 4, fit(words, R0 - L0 - 10), C.fg)
        let fx = R0 - 1
        for (const who of from.trim().split(/\s+/).filter(Boolean).reverse()) {
          const lane = who === 'G' ? 'gemini' : who === 'X' ? 'codex' : 'claude'
          term.put(fx, y, lane[0]!, C[lane], { b: true })
          fx -= 2
        }
        y++
      } else if (entry.mark === 'h') {
        y++
        put(L0, fit(text, R0 - L0), C.amber, { b: true })
        y++
      } else if (entry.mark === '?') {
        const [letter = '', body = ''] = text.split('|')
        term.put(L0 + 1, y, letter, C.amber, { b: true })
        for (const part of this.wrap(body, R0 - L0 - 5)) {
          if (y >= room) break
          put(L0 + 4, part, C.fg)
          y++
        }
      } else {
        put(L0 + 4, fit(text, R0 - L0 - 4), C.faint)
        y++
      }
    }
    if (s.state === 'running' && y < room && lineOk(n + 1)) {
      y++
      term.put(L0, y, spin(s.lane, t), C[s.lane], { b: true })
      const word = s.lane === 'claude' ? 'Thinking…' : s.lane === 'codex' ? 'Working…' : 'Planning…'
      const x2 = term.put(L0 + 2, y, word, shimmer(C[s.lane], t, word.length))
      term.put(x2 + 1, y, `(${elapsed(t - s.t0)})`, C.faint)
    }
  }

  /** An agent's window: its steps in this flow, newest first, the working one opened up. */
  private drawAgent(frame: Frame, lane: Lane, DX: number, DW: number, paneBottom: number) {
    const term = this.term
    const flow = this.flow
    const t = frame.now
    const win = { claude: 1, gemini: 2, codex: 3, you: 0 }[lane]
    term.put(DX + 2, 0, ` ${win}:${lane} `, C[lane], { b: true })
    const mine = [...frame.steps.values()].filter(s => s.lane === lane).sort((a, b) => b.t0 - a.t0)
    const L0 = DX + 2, R0 = DX + DW - 2
    let y = 2
    if (!mine.length) { term.put(L0, y, 'nothing in this flow yet', C.faint); return }
    for (const s of mine) {
      if (y >= paneBottom - 1) break
      const node = s.state === 'running' ? spin(lane, t) : s.state === 'failed' ? '✗' : '●'
      term.put(L0, y, node, s.state === 'failed' ? C.red : C[lane], { b: true })
      const x = term.put(L0 + 2, y, fit(s.title ?? '', R0 - L0 - 12), s.state === 'running' ? shimmer(C.fg, t, (s.title ?? '').length) : C.fg, { b: s.state === 'running' })
      const tail = s.state === 'running' ? elapsed(t - s.t0) : s.t1 !== undefined ? took(s.t1 - s.t0) : ''
      term.put(R0 - tail.length, y, tail, C.faint)
      const id = s.id
      this.hots.push({ x: L0, y, w: R0 - L0, run: () => flow.select(id), step: id })
      void x
      y++
      if (s.summary && s.state !== 'running') { term.put(L0 + 2, y++, fit(s.summary, R0 - L0 - 2), C.dim) }
      if (s.state === 'running') {
        for (const entry of s.logs.filter(e => e.t <= t).slice(-6)) {
          if (y >= paneBottom - 1) break
          const mark = entry.mark === '●' ? '●' : entry.mark === '⎿' ? '⎿' : entry.mark === '✻' ? '✻' : '·'
          term.put(L0 + 2, y, mark, mark === '●' ? C[lane] : C.faint)
          term.put(L0 + 4, y, fit(entry.text, R0 - L0 - 4), entry.mark === '●' ? C.fg : C.dim)
          y++
        }
      }
      y++
    }
  }

  private drawSettings(DX: number, DW: number, paneBottom: number) {
    const term = this.term
    const flow = this.flow
    const st = flow.settings
    term.put(DX + 2, 0, ' 4:settings ', C.fg, { b: true })
    if (!st) return
    const L0 = DX + 2, R0 = DX + DW - 2
    let y = 2
    const row = (label: string, value: string, run: (() => void) | null, color: string = C.fg) => {
      if (y >= paneBottom - 1) return
      term.put(L0, y, label, C.dim)
      const vx = L0 + 16
      const end = term.put(vx, y, fit(value, R0 - vx), color, { b: Boolean(run) })
      if (run) this.hots.push({ x: vx, y, w: end - vx, run })
      y++
    }
    const cycle = <T>(list: readonly T[], current: T) => list[(list.indexOf(current) + 1) % list.length] as T
    row('folder', st.workdir ?? 'none', () => void flow.api.pickFolder(), C.claude)
    for (const path of st.recent.filter(p => p !== st.workdir).slice(0, 4)) row('', path, () => void flow.api.setWorkdir(path), C.dim)
    y++
    row('look', st.theme === 'cli' ? 'terminal' : 'drawn', () => void flow.setTheme(st.theme === 'cli' ? 'drawn' : 'cli'))
    row('companion', st.companion === 'auto' ? 'shows while work runs' : 'off', () => void flow.api.companionToggle())
    row('on top', st.pinned ? 'yes' : 'no', () => void flow.api.pin())
    y++
    row('codex model', st.codexModel, () => void flow.api.setModel(cycle(st.models, st.codexModel)))
    row('codex effort', st.efforts.codex ?? 'default', () => void flow.api.setEffort('codex', cycle([null, ...st.effortChoices.codex], st.efforts.codex)))
    row('codex edits', st.mode === 'workspace-write' ? 'may edit files' : 'read only', () => void flow.api.setMode(st.mode === 'workspace-write' ? 'read-only' : 'workspace-write'))
    row('gemini effort', st.efforts.gemini ?? 'default', () => void flow.api.setEffort('gemini', cycle([null, ...st.effortChoices.gemini], st.efforts.gemini)))
    if (st.bashError) { y++; row('bash', st.bashError, null, C.red) }
    if (flow.flows.length > 1) {
      y++
      term.put(L0, y++, 'flows', C.dim)
      for (const one of flow.flows.slice().reverse().slice(0, 6)) {
        if (y >= paneBottom - 1) break
        const on = one.id === flow.info?.id
        const end = term.put(L0 + 2, y, fit(`${clock(one.t)}  ${one.title}`, R0 - L0 - 2), on ? C.bright : C.dim, { b: on })
        const id = one.id
        this.hots.push({ x: L0 + 2, y, w: end - L0 - 2, run: () => void flow.api.showFlow(id) })
        y++
      }
    }
  }

  // ---------------------------------------------------------------- bottom

  private drawPrompt(frame: Frame, rows: number) {
    const term = this.term
    const flow = this.flow
    const t = frame.now
    const { cols } = term
    const by = rows - 5
    const text = flow.input
    term.box(0, by, cols, 3, text ? C.dim : C.rule)
    term.put(2, by + 1, '>', text ? C.bright : C.dim, { b: true })
    const focused = document.activeElement === this.field
    const cursorOn = focused && Math.floor(t / 0.53) % 2 === 0
    const caret = Math.min(this.field.selectionStart ?? text.length, text.length)
    const room = cols - 20
    const start = Math.max(0, caret - room)
    const shown = text.slice(start, start + room)
    const target = flow.target()
    const gate = frame.gate
    if (text) {
      const at = shown.match(/^@(codex|gemini)\b/i)
      let x = 4
      if (at && start === 0) x = term.put(x, by + 1, at[0], C[target], { b: true })
      term.put(x, by + 1, shown.slice(at && start === 0 ? at[0].length : 0), C.bright)
      if (cursorOn) term.put(4 + caret - start, by + 1, shown[caret - start] ?? ' ', C.bg, { bg: C.fg })
      const review = gate && !gate.noAuto && target === 'claude'
      const route = review ? '→ review' : `→ ${target}`
      term.put(cols - 4 - route.length, by + 1, route, review ? C.amber : C[target], { b: true })
    } else {
      if (cursorOn) term.put(4, by + 1, ' ', C.bright, { bg: C.fg })
      const starts = !flow.info || flow.info.state === 'done'
      const hint = gate?.noAuto ? 'choose yes or not now above' : gate ? 'type a change to this review, or choose above with ←→' : starts ? 'what should the workflow do? enter starts it' : 'steer the work, or @gemini @codex to ask one directly'
      term.put(6, by + 1, fit(hint, cols - 22), C.faint)
      const route = gate && !gate.noAuto ? '→ review' : '→ claude'
      term.put(cols - 4 - route.length, by + 1, route, mix(gate && !gate.noAuto ? C.amber : C.claude, C.bg, 0.35))
    }
    let hx = 2
    const keys: [string, string][] = gate ? [['⏎', 'choose'], ['←→', 'answers'], ['^p', flow.paused ? 'resume' : 'pause'], ['tab', 'target'], ['esc', 'back']] : [['⏎', 'send'], ['tab', 'target'], ['↑↓', 'steps'], ['^p', flow.paused ? 'resume' : 'pause'], ['^t', 'theme'], ['esc', 'back']]
    for (const [key, word] of keys) {
      hx = term.put(hx, rows - 2, key, C.dim)
      hx = term.put(hx + 1, rows - 2, word, C.faint) + 3
    }
    if (flow.notice && t - flow.notice.at < NOTICE_S) term.put(cols - 2 - flow.notice.text.length, rows - 2, flow.notice.text, C.amber)
  }

  private drawStatus(frame: Frame, rows: number) {
    const term = this.term
    const flow = this.flow
    const t = frame.now
    const { cols } = term
    const sy = rows - 1
    term.shade(0, sy, cols, C.bar)
    let sx = term.put(1, sy, '[bridge]', C.claude, { b: true, bg: C.bar }) + 2
    WINDOWS.forEach((win, i) => {
      const active = flow.pane === win.pane
      const label = `${i}:${win.name}${active ? '*' : ''}`
      const start = sx
      sx = term.put(sx, sy, label, active ? C.bright : C.dim, { b: active, bg: C.bar })
      const pane = win.pane
      this.hots.push({ x: start, y: sy, w: sx - start, run: () => flow.setPane(pane) })
      sx += 2
    })
    let rx = cols - 1
    const seg = (text: string, color: string, extra: { b?: boolean; bg?: string } = {}, run?: () => void) => {
      rx -= text.length
      term.put(rx, sy, text, color, { bg: C.bar, ...extra })
      if (run) this.hots.push({ x: rx, y: sy, w: text.length, run })
      rx -= 2
    }
    seg(clock(t), C.dim)
    seg('look: terminal', C.dim, {}, () => void flow.setTheme('drawn'))
    seg(flow.paused ? ' ▶ resume ' : 'pause', flow.paused ? C.bg : C.dim, flow.paused ? { bg: C.amber, b: true } : {}, () => void flow.togglePause())
    const phases = this.phases()
    if (frame.phase >= 0) seg(`${frame.phase + 1}/${phases.length} ${phases[frame.phase] ?? ''}`, C.dim)
    if (frame.running.length) seg(`● ${frame.running.length} working`, C.fg)
    const gate = frame.gate
    if (gate) {
      const age = t - gate.t0
      const flashOn = age < 1.2 && Math.floor(age / 0.2) % 2 === 0
      const left = gateLeft(gate, t)
      const words = gate.noAuto ? ' ◷ your yes is needed ' : left === null ? ' ◷ waiting for you · paused ' : ` ◷ waiting for you · ${left}s `
      seg(words, flashOn ? C.bg : C.amber, flashOn ? { bg: C.amber, b: true } : { b: true })
    }
  }
}
