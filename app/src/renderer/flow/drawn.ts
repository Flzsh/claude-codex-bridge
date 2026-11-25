// The drawn theme: the same flow, drawn by hand on paper. Four lanes, a card
// per step, ink lines that draw themselves between them. A card that is being
// worked on opens a live strip (what it does now, and how far), an ink line
// runs round it and a highlighter keeps passing over it. The sheet on the
// right holds the selected step, an agent's page, or the settings.

import { stagesFor, type Size } from '../../../../core/console'
import { fold, LANE, LANES, type Lane, type Step } from '../../../../core/flow'
import { gateLeft, gateOptions, type Flow, type Frame, type Pane } from './controller'
import {
  cap, CLAY_UI, clamp, clockSvg, DEEP, ease, easeInOut, elapsed, esc, faceSvg, failSvg, FILL, frame, linePath, loopSvg,
  meterSvg, NAME, NS, place, seedFrom, setFrame, setWorking, sizeFrame, tickSvg, took, wipe, INK, type Fill, type Frame as InkFrame,
} from './ink'

const GAP_Y = 44
const LIVE_H = 46
const EDGE_TIME = 0.5
const isWork = (s: Step) => s.kind !== 'gate' && s.kind !== 'steer'
/** What a card has to be built as: its kind, its lane, and for a review whether it needs a real yes. */
const shapeOf = (s: Step) => `${s.kind ?? 'step'}:${s.lane}:${s.noAuto ? 'yes' : ''}`
const tNodeOf = (s: Step) => (s.after.length ? s.t0 + EDGE_TIME : s.t0)

/** How open a card's live strip is at t: opens as work starts, folds away when it is done. */
function liveK(s: Step, t: number): number {
  if (!isWork(s) || s.t1 === s.t0) return 0
  const open = ease(clamp((t - tNodeOf(s) - 0.2) / 0.4))
  return s.t1 === undefined || t < s.t1 ? open : open * (1 - easeInOut(clamp((t - s.t1) / 0.5)))
}

type Box = { x: number; y: number; w: number; h: number; cx: number; b: number }
type Card = {
  el: HTMLElement
  frame: InkFrame
  title: HTMLElement | null
  sum: HTMLElement | null
  st: HTMLElement | null
  mark: SVGSVGElement | null
  clock: SVGSVGElement | null
  btns: HTMLButtonElement[]
  btnFrames: InkFrame[]
  live: HTMLElement | null
  act: HTMLElement | null
  bar: HTMLElement | null
  count: HTMLElement | null
  text: Record<string, string>
  /** What the card was built as: a step can start as notes and turn into a review once its gate opens. */
  shape: string
}
type Edge = { g: SVGGElement; lines: SVGPathElement[]; head: SVGPathElement; pulse: SVGCircleElement | null; dashed?: SVGPathElement }
type Tag = { el: HTMLElement; text: HTMLElement; frame: InkFrame | null; key: string }

const div = (className: string, html = '') => {
  const el = document.createElement('div')
  el.className = className
  el.innerHTML = html
  return el
}

export class DrawnView {
  private readonly page: HTMLElement
  private readonly board: HTMLElement
  private readonly heads: HTMLElement
  private readonly flowEl: HTMLElement
  private readonly edgesSvg: SVGSVGElement
  private readonly sheet: HTMLElement
  private readonly sheetBody: HTMLElement
  private readonly sheetTabs: HTMLElement
  private readonly live: HTMLButtonElement
  private readonly notice: HTMLElement
  private readonly steer: HTMLElement
  private readonly input: HTMLInputElement
  private readonly toEl: HTMLElement
  private readonly sendEl: HTMLElement
  private sendFrame: InkFrame | null = null
  private toFrame: InkFrame | null = null
  private toWho: Lane | 'review' | null = null
  private headEls: { el: HTMLElement; f: InkFrame; state: HTMLElement; word: string; changed: number; before: string }[] = []
  private readonly tags: Record<'task' | 'size' | 'step' | 'status' | 'theme' | 'pause', Tag>
  private cards = new Map<string, Card>()
  private edges = new Map<string, Edge>()
  private sheetKey = ''
  private context = ''
  private sentAt = -9
  private back = 0
  private width = 0
  private height = 0
  private boardW = 0
  private laneW = 0
  private cardW = 0
  private sheetW = 372
  private headW = 186
  private readonly off: (() => void)[] = []

  constructor(private readonly root: HTMLElement, private readonly flow: Flow) {
    root.classList.add('theme-drawn')
    this.page = div('drawn-page')
    const top = div('d-top', `<span class="d-brand"><span class="d-mark">${faceSvg('mark', 26)}</span>Bridge</span>`)
    const tag = (key: string, cls = 'd-tag'): Tag => {
      // only the tags that do something are buttons
      const el = document.createElement(key === 'pause' || key === 'theme' || key === 'status' ? 'button' : 'span')
      el.className = cls
      const text = document.createElement('span')
      text.className = 'wipe'
      el.append(text)
      top.append(el)
      return { el, text, frame: null, key }
    }
    this.tags = {
      task: tag('task', 'd-task'),
      size: tag('size'),
      step: tag('step'),
      status: tag('status'),
      pause: tag('pause'),
      theme: tag('theme'),
    }
    top.insertBefore(div('d-sp'), this.tags.status.el)
    this.board = div('d-board')
    this.heads = div('d-heads')
    this.flowEl = div('d-flow')
    this.edgesSvg = document.createElementNS(NS, 'svg')
    this.edgesSvg.setAttribute('class', 'ink d-edges')
    this.flowEl.append(this.edgesSvg)
    this.sheet = div('d-sheet')
    this.sheetTabs = div('d-sheet-tabs')
    this.sheetBody = div('d-sheet-body')
    this.live = document.createElement('button')
    this.live.className = 'd-follow'
    this.live.textContent = 'Follow live'
    this.sheet.append(this.sheetTabs, this.live, this.sheetBody)
    this.notice = div('d-notice')
    const fade = div('d-fade')
    this.steer = div('d-steer')
    const box = div('d-steer-box')
    this.toEl = document.createElement('button')
    this.toEl.className = 'd-to'
    this.input = document.createElement('input')
    this.input.className = 'd-input'
    this.input.spellcheck = false
    this.input.placeholder = 'Steer the work, or @Gemini, @Codex to ask one directly…'
    this.sendEl = document.createElement('button')
    this.sendEl.className = 'd-send'
    this.sendEl.setAttribute('aria-label', 'Send')
    this.sendEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="${INK}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 14.6 8.8 3.6M4.4 8.1 8.9 3.4l4.6 4.5"/></svg>`
    box.append(this.toEl, this.input, this.sendEl)
    this.steer.append(box, this.notice)
    this.board.append(this.heads, this.flowEl, fade)
    this.page.append(top, this.board, this.sheet, this.steer)
    root.append(this.page)
    this.input.value = flow.input
    this.layout()
    this.wire()
    this.input.focus()
  }

  destroy() {
    for (const off of this.off) off()
    this.root.classList.remove('theme-drawn')
    this.page.remove()
  }

  // ---------------------------------------------------------------- sizes

  /** Everything that depends on the window's size, drawn again when it changes. */
  private layout() {
    const w = this.root.clientWidth, h = this.root.clientHeight
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    // A narrower window gives the sheet less room first, so the four lanes keep theirs.
    this.sheetW = w >= 1320 ? 372 : w >= 1100 ? 320 : 290
    this.boardW = w - this.sheetW - 36
    this.laneW = (this.boardW - 30) / 4
    this.cardW = Math.round(Math.min(236, this.laneW - 16))
    place(this.board, { width: this.boardW })
    place(this.heads, { width: this.boardW })
    place(this.flowEl, { width: this.boardW })
    place(this.sheet, { width: this.sheetW })
    this.root.classList.toggle('is-narrow', this.cardW < 215)
    this.edgesSvg.setAttribute('width', String(this.boardW))
    this.edgesSvg.setAttribute('height', '6000')
    // rules and lane separators
    this.board.querySelector('.d-rules')?.remove()
    seedFrom('rules')
    const rules = document.createElementNS(NS, 'svg')
    rules.setAttribute('class', 'ink d-rules')
    rules.setAttribute('width', String(this.boardW))
    rules.setAttribute('height', String(h))
    rules.innerHTML = [1, 2, 3].map(i => `<path d="${linePath(22 + this.laneW * i, 0, 22 + this.laneW * i, h, 1.1, 34)}" fill="none" stroke="#cdc8bc" stroke-width="1.2" stroke-linecap="round" stroke-dasharray="2 7"/>`).join('')
      + `<path d="${linePath(18, 73, this.boardW - 4, 73, 0.9, 60)}" fill="none" stroke="${INK}" stroke-opacity=".35" stroke-width="1.1" stroke-linecap="round"/>`
    this.board.prepend(rules)
    // lane heads
    this.heads.replaceChildren()
    this.headW = Math.max(120, Math.min(186, Math.floor(this.laneW - 20)))
    this.headEls = LANES.map((who, i) => {
      const el = div('d-lane-head', `<span class="face">${faceSvg(who)}</span><span class="d-lane-name">${NAME[who]}</span><span class="d-lane-state"></span>`)
      el.style.left = `${this.laneX(i)}px`
      el.style.transform = `translateX(-50%) rotate(${[-1.3, 0.9, -0.7, 1.2][i]}deg)`
      el.style.width = `${this.headW}px`
      this.heads.append(el)
      const f = frame(el, this.headW, 38, { fill: who, kind: 'tag', key: 'head' + who, live: true, runColor: DEEP[who] })
      return { el, f, state: el.querySelector('.d-lane-state') as HTMLElement, word: '', changed: 0, before: 'idle' }
    })
    // steer box and sheet
    const steerW = Math.min(720, this.boardW - 60)
    place(this.steer, { width: steerW, left: (this.boardW - steerW) / 2 })
    const box = this.steer.firstElementChild as HTMLElement
    box.querySelector('.frame')?.remove()
    frame(box, steerW, 56, { fill: 'sheet', kind: 'box', key: 'steer' })
    this.sendEl.querySelector('.frame')?.remove()
    this.sendFrame = frame(this.sendEl, 38, 34, { fill: 'clay', kind: 'btn', key: 'send' })
    this.sheet.querySelector(':scope > .frame')?.remove()
    frame(this.sheet, this.sheetW, Math.max(200, h - 102 - 112), { fill: 'sheet', kind: 'box', key: 'sheet' })
    for (const tag of Object.values(this.tags)) { tag.frame?.el.remove(); tag.frame = null; delete tag.el.dataset.fill }
    for (const card of this.cards.values()) card.el.remove()
    for (const edge of this.edges.values()) edge.g.remove()
    this.cards.clear()
    this.edges.clear()
    this.toWho = null
    this.sheetKey = ''
  }

  private laneX(i: number) {
    return 22 + this.laneW * (i + 0.5)
  }

  /** A title too long for one line on this card wraps to a second (the card grows to fit it). */
  private titleLines(s: Step) {
    const room = this.cardW - 30 - 28 - (this.cardW < 215 ? 0 : 36)
    return (s.title ?? '').length * 7.4 > room ? 2 : 1
  }

  private heightOf(s: Step, t: number) {
    return s.kind === 'gate' ? 128 : s.kind === 'steer' ? 58 : 70 + (this.titleLines(s) - 1) * 17 + LIVE_H * liveK(s, t)
  }

  private widthOf(s: Step) {
    return s.kind === 'gate' ? Math.min(304, this.laneW * 2 - 20) : s.kind === 'steer' ? Math.min(206, this.cardW) : this.cardW
  }

  /**
   * Where every card sits at time t: rows in time order. A step joins the
   * newest row when it started within a few seconds of it, its lane is free
   * there, and none of the steps it follows sit in that row.
   */
  private placeAll(steps: Map<string, Step>, t: number): Map<string, Box> {
    const order = [...steps.values()].sort((a, b) => a.t0 - b.t0 || LANE[a.lane] - LANE[b.lane])
    const rows: { t0: number; ids: Set<string>; lanes: Set<Lane>; h: number }[] = []
    const rowOf = new Map<string, number>()
    for (const s of order) {
      const last = rows[rows.length - 1]
      const joins = last && s.t0 - last.t0 < 5 && !last.lanes.has(s.lane) && !s.after.some(id => last.ids.has(id)) && s.kind !== 'steer'
      const row = joins ? last : { t0: s.t0, ids: new Set<string>(), lanes: new Set<Lane>(), h: 0 }
      if (!joins) rows.push(row)
      row.ids.add(s.id)
      row.lanes.add(s.lane)
      row.h = Math.max(row.h, this.heightOf(s, t))
      rowOf.set(s.id, rows.length - 1)
    }
    const rowY: number[] = []
    let y = 16
    for (const row of rows) { rowY.push(y); y += row.h + GAP_Y }
    const box = new Map<string, Box>()
    for (const s of order) {
      const w = this.widthOf(s), h = this.heightOf(s, t), y0 = rowY[rowOf.get(s.id) ?? 0] ?? 16
      const x = s.kind === 'gate' ? 32 : this.laneX(LANE[s.lane]) - w / 2
      box.set(s.id, { x, y: y0, w, h, cx: s.kind === 'gate' ? this.laneX(0) : x + w / 2, b: y0 + h })
    }
    return box
  }

  /** The scroll that keeps the newest work above the steer box, averaged over the last moments so it glides. */
  private scrollAt(t: number): number {
    // the board starts 28 px down; under it the lane heads (74) and the fade over the steer box (100)
    const view = this.height - 28 - 74 - 100
    const target = (when: number) => {
      const box = this.placeAll(this.flow.foldAt(when).steps, when)
      let bottom = 0
      for (const b of box.values()) bottom = Math.max(bottom, b.b)
      return Math.max(0, bottom + 30 - view)
    }
    let sum = 0, weights = 0
    for (let k = 0; k <= 8; k++) {
      const w = 1 - Math.abs(k - 4) / 5
      sum += target(t - 0.8 + k * 0.1) * w
      weights += w
    }
    return sum / weights
  }

  // ---------------------------------------------------------------- input

  private wire() {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (event: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(type, fn as EventListener)
      this.off.push(() => el.removeEventListener(type, fn as EventListener))
    }
    const flow = this.flow
    on(this.input, 'input', () => flow.typed(this.input.value, flow.frame().gate))
    // the shortcuts work wherever the focus is
    on(window, 'keydown', event => {
      const ctrl = event.ctrlKey || event.metaKey
      if (ctrl && event.key.toLowerCase() === 'p') { event.preventDefault(); void flow.togglePause() }
      else if (ctrl && event.key.toLowerCase() === 't') { event.preventDefault(); void flow.setTheme('cli') }
      else if (ctrl && event.key === ',') { event.preventDefault(); flow.setPane('settings') }
      else if (event.key === 'Escape') {
        if (this.input.value) { this.input.value = ''; flow.input = ''; void flow.release() }
        else if (flow.pinned) flow.select(null)
        else flow.setPane('detail')
      }
    })
    on(this.input, 'keydown', event => {
      if (event.key === 'Tab') { event.preventDefault(); flow.cycleTarget(); this.input.value = flow.input }
      else if (event.key === 'Enter') { event.preventDefault(); this.send(flow.frame()) }
    })
    on(this.live, 'click', () => flow.select(null))
    on(this.tags.status.el, 'click', () => { const gate = flow.frame().gate; if (gate) { this.back = 0; flow.select(gate.id) } })
    on(this.tags.task.el, 'click', () => { if (!flow.settings?.workdir) void flow.api.pickFolder() })
    on(this.sendEl, 'click', () => this.send(flow.frame()))
    on(this.toEl, 'click', () => { flow.cycleTarget(); this.input.value = flow.input; this.input.focus() })
    on(this.tags.theme.el, 'click', () => void flow.setTheme('cli'))
    on(this.tags.pause.el, 'click', () => void flow.togglePause())
    on(this.flowEl, 'click', event => {
      const target = event.target as HTMLElement
      const btn = target.closest<HTMLElement>('.d-btn')
      const card = target.closest<HTMLElement>('.d-card, .d-note')
      if (btn && card?.dataset.id) {
        const gate = flow.frame().steps.get(card.dataset.id)
        if (gate && gate.state === 'waiting') this.choose(gate, btn.dataset.answer)
        return
      }
      if (card?.dataset.id) flow.select(card.dataset.id)
    })
    on(this.flowEl, 'mouseover', event => {
      const card = (event.target as HTMLElement).closest<HTMLElement>('.d-card, .d-note')
      flow.hover = card?.dataset.id ?? null
    })
    on(this.board, 'wheel', event => { this.back = Math.max(0, this.back - event.deltaY) })
    on(this.sheetTabs, 'click', event => {
      const pane = (event.target as HTMLElement).closest<HTMLElement>('[data-pane]')?.dataset.pane
      if (pane) flow.setPane(pane as Pane)
    })
    on(this.sheetBody, 'click', event => {
      const el = (event.target as HTMLElement).closest<HTMLElement>('[data-tab], [data-step], [data-act]')
      if (!el) return
      if (el.dataset.tab) flow.setTab(el.dataset.tab as typeof flow.tab)
      if (el.dataset.step) flow.select(el.dataset.step)
      if (el.dataset.act) this.setting(el.dataset.act, el.dataset.value)
    })
    on(window, 'resize', () => this.layout())
  }

  private send(frame: Frame) {
    if (!this.flow.input.trim()) return
    this.sentAt = frame.now
    void this.flow.send(frame.gate)
    this.input.value = ''
  }

  private choose(gate: Step, answer: string | undefined) {
    if (answer === 'approve' || answer === 'decline') void this.flow.answer(gate, answer)
    else if (answer === 'pause') void this.flow.togglePause()
    else if (answer === 'focus') { this.input.focus(); void this.flow.holdForSteer(gate) }
  }

  private setting(act: string, value?: string) {
    const flow = this.flow
    const st = flow.settings
    if (!st) return
    const cycle = <T>(list: readonly T[], current: T) => list[(list.indexOf(current) + 1) % list.length] as T
    if (act === 'folder') void flow.api.pickFolder()
    if (act === 'recent' && value) void flow.api.setWorkdir(value)
    if (act === 'theme') void flow.setTheme(st.theme === 'cli' ? 'drawn' : 'cli')
    if (act === 'companion') void flow.api.companionToggle()
    if (act === 'pin') void flow.api.pin()
    if (act === 'model') void flow.api.setModel(cycle(st.models, st.codexModel))
    if (act === 'codex-effort') void flow.api.setEffort('codex', cycle([null, ...st.effortChoices.codex], st.efforts.codex))
    if (act === 'gemini-effort') void flow.api.setEffort('gemini', cycle([null, ...st.effortChoices.gemini], st.efforts.gemini))
    if (act === 'mode') void flow.api.setMode(st.mode === 'workspace-write' ? 'read-only' : 'workspace-write')
    if (act === 'flow' && value) void flow.api.showFlow(value)
  }

  // ---------------------------------------------------------------- draw

  render() {
    this.layout()
    const flow = this.flow
    const frame = flow.frame()
    const t = frame.now
    const steps = frame.steps
    const box = this.placeAll(steps, t)
    const target = this.scrollAt(t)
    this.back = Math.min(this.back, target)
    const scroll = Math.max(0, target - this.back)
    this.flowEl.style.transform = `translateY(${(-scroll).toFixed(2)}px)`

    // another folder or another flow: start from a clean page, so nothing is reused under the same id
    const context = `${flow.settings?.workdir ?? ''}|${flow.info?.id ?? ''}`
    if (context !== this.context) {
      this.context = context
      for (const card of this.cards.values()) card.el.remove()
      for (const edge of this.edges.values()) edge.g.remove()
      this.cards.clear()
      this.edges.clear()
      this.sheetKey = ''
      this.back = 0
    }
    // forget what is no longer in the flow
    for (const [id, card] of this.cards) if (!steps.has(id)) { card.el.remove(); this.cards.delete(id) }
    for (const [id, edge] of this.edges) if (!steps.has(id)) { edge.g.remove(); this.edges.delete(id) }

    this.drawEdges(steps, box, t)
    for (const s of steps.values()) this.drawCard(s, box.get(s.id), t, frame)
    this.drawHeader(frame)
    this.drawHeads(frame)
    this.drawSteer(frame)
    this.drawSheet(frame)
  }

  private drawEdges(steps: Map<string, Step>, box: Map<string, Box>, t: number) {
    for (const s of steps.values()) {
      if (s.kind === 'steer') { this.drawSteerEdge(s, steps, box, t); continue }
      const parents = s.after.filter(id => box.has(id))
      if (!parents.length) continue
      let edge = this.edges.get(s.id)
      const gate = s.kind === 'gate'
      if (!edge) {
        const color = gate ? CLAY_UI : INK, width = gate ? 1.8 : 1.4
        const g = document.createElementNS(NS, 'g')
        g.innerHTML = parents.map(() => `<path class="e" pathLength="1" stroke-dasharray="1 1" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')
          + `<path class="h" pathLength="1" stroke-dasharray="1 1" fill="none" stroke="${color}" stroke-width="${gate ? 1.8 : 1.5}" stroke-linecap="round" stroke-linejoin="round"/>`
          + (isWork(s) ? `<circle class="p" r="4.4" fill="${FILL[s.lane]}" stroke="${INK}" stroke-width="1.3" opacity="0"/>` : '')
        this.edgesSvg.append(g)
        edge = { g, lines: [...g.querySelectorAll<SVGPathElement>('.e')], head: g.querySelector('.h') as SVGPathElement, pulse: g.querySelector('.p') }
        this.edges.set(s.id, edge)
      }
      const b = box.get(s.id)!
      const x2 = b.cx, y2 = b.y - 8
      const lowest = Math.max(...parents.map(id => box.get(id)!.b))
      const mid = lowest + 7 + Math.min((y2 - lowest - 7) * 0.5, 16)
      seedFrom('edge' + s.id)
      parents.forEach((id, i) => {
        const a = box.get(id)!
        let d = linePath(a.cx, a.b + 7, a.cx, mid, 0.6, 14, true, 3)
        if (Math.abs(x2 - a.cx) > 4) d += linePath(a.cx, mid, x2, mid, 0.8, 50, false, Math.max(2, Math.round(Math.abs(x2 - a.cx) / 50)))
        d += linePath(x2, mid, x2, y2, 0.6, 14, false, 3)
        edge.lines[i]?.setAttribute('d', d)
      })
      const k = easeInOut(clamp((t - s.t0) / (EDGE_TIME * 0.85)))
      for (const p of edge.lines) p.setAttribute('stroke-dashoffset', (1 - k).toFixed(3))
      edge.head.setAttribute('d', `M${x2 - 5.5} ${y2 - 7} L${x2} ${y2 + 0.5} L${x2 + 5.5} ${y2 - 7}`)
      edge.head.setAttribute('stroke-dashoffset', (1 - ease(clamp((t - s.t0 - EDGE_TIME * 0.75) / 0.15))).toFixed(3))
      // while the step works, a bead keeps running down the line into it
      if (edge.pulse) {
        const lk = liveK(s, t)
        edge.pulse.setAttribute('opacity', lk.toFixed(3))
        const path = edge.lines[edge.lines.length - 1]
        if (lk > 0 && path) {
          const len = path.getTotalLength()
          const p = path.getPointAtLength(len * easeInOut(((t - tNodeOf(s)) / 1.3) % 1))
          edge.pulse.setAttribute('cx', p.x.toFixed(1))
          edge.pulse.setAttribute('cy', p.y.toFixed(1))
        }
      }
    }
  }

  /** A steer points from its note to the step of the agent it went to. */
  private drawSteerEdge(s: Step, steps: Map<string, Step>, box: Map<string, Box>, t: number) {
    const target = [...steps.values()].filter(x => x.lane === s.to && isWork(x) && x.t0 <= s.t0).sort((a, b) => b.t0 - a.t0)[0]
    const a = box.get(s.id), b = target ? box.get(target.id) : undefined
    if (!a || !b) return
    let edge = this.edges.get(s.id)
    if (!edge) {
      const g = document.createElementNS(NS, 'g')
      g.innerHTML = `<mask id="steer-mask-${esc(s.id)}" maskUnits="userSpaceOnUse"><path class="e" pathLength="1" stroke-dasharray="1 1" fill="none" stroke="#fff" stroke-width="8"/></mask>
        <path class="d" mask="url(#steer-mask-${esc(s.id)})" fill="none" stroke="${INK}" stroke-width="1.3" stroke-linecap="round" stroke-dasharray="4 5"/>
        <path class="h" pathLength="1" stroke-dasharray="1 1" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
      this.edgesSvg.append(g)
      edge = { g, lines: [g.querySelector('mask .e') as SVGPathElement], dashed: g.querySelector('.d') as SVGPathElement, head: g.querySelector('.h') as SVGPathElement, pulse: null }
      this.edges.set(s.id, edge)
    }
    const right = b.x > a.x
    const x1 = right ? a.x + a.w + 6 : a.x - 6, y1 = a.y + a.h / 2
    const x2 = b.x + 26, y2 = b.b + 9
    seedFrom('steer' + s.id)
    const d = linePath(x1, y1, x2, y1, 0.7, 40, true, 12) + linePath(x2, y1, x2, y2, 0.6, 12, false, 3)
    edge.lines[0]?.setAttribute('d', d)
    edge.dashed?.setAttribute('d', d)
    edge.head.setAttribute('d', `M${x2 - 5.5} ${y2 + 7} L${x2} ${y2 - 0.5} L${x2 + 5.5} ${y2 + 7}`)
    edge.lines[0]?.setAttribute('stroke-dashoffset', (1 - easeInOut(clamp((t - s.t0 - 0.35) / 0.6))).toFixed(3))
    edge.head.setAttribute('stroke-dashoffset', (1 - ease(clamp((t - s.t0 - 0.9) / 0.15))).toFixed(3))
  }

  private makeCard(s: Step, b: Box): Card {
    const el = div(s.kind === 'steer' ? 'd-note' : s.kind === 'gate' ? 'd-card d-gate' : 'd-card')
    el.dataset.id = s.id
    if (s.kind === 'gate') {
      el.innerHTML = `<div class="d-gate-head"><svg class="d-clock" viewBox="0 0 46 46" width="46" height="46"></svg><div><div class="d-ttl wipe"></div><div class="d-sum wipe"></div></div></div>
        <div class="d-acts">${gateOptions(s, this.flow.paused).map(o => `<button class="d-btn" data-answer="${o.answer}">${esc(cap(o.word))}</button>`).join('')}</div>`
    } else if (s.kind === 'steer') {
      el.innerHTML = `<div class="wipe"><b>You → ${esc(NAME[(s.to as Lane) ?? 'claude'] ?? s.to)}</b></div><div class="d-sum wipe"></div>`
    } else {
      el.innerHTML = `<div class="d-row1"><svg class="d-markico" viewBox="0 0 22 22" width="20" height="20"></svg><span class="d-ttl wipe"></span><span class="d-st"></span></div><div class="d-sum wipe"></div>
        <div class="d-live"><div class="d-act"><span class="d-dot"></span><span class="d-act-text"></span></div><div class="d-meter"><span class="d-bar"></span><span class="d-count"></span></div></div>`
    }
    this.flowEl.append(el)
    const fill: Fill = s.kind === 'gate' ? 'gold' : s.kind === 'steer' ? 'manila' : s.lane
    const card: Card = {
      el,
      frame: frame(el, b.w, b.h, { fill, kind: s.kind === 'gate' ? 'gate' : 'card', key: s.id, live: isWork(s), runColor: DEEP[s.lane] }),
      title: el.querySelector('.d-ttl'), sum: el.querySelector('.d-sum'), st: el.querySelector('.d-st'),
      mark: el.querySelector('.d-markico'), clock: el.querySelector('.d-clock'),
      btns: [...el.querySelectorAll<HTMLButtonElement>(".d-btn")], btnFrames: [],
      live: el.querySelector('.d-live'), act: el.querySelector('.d-act-text'), bar: el.querySelector('.d-bar'), count: el.querySelector('.d-count'),
      text: {},
      shape: shapeOf(s),
    }
    const dot = el.querySelector<HTMLElement>('.d-dot')
    if (dot) dot.style.background = DEEP[s.lane]
    card.btnFrames = card.btns.map((btn, i) => frame(btn, btn.offsetWidth || 70, 29, { fill: i === 0 ? 'clay' : 'sheet', kind: 'btn', key: s.id + i }))
    this.cards.set(s.id, card)
    return card
  }

  private setText(card: Card, key: string, el: HTMLElement | null, value: string) {
    if (el && card.text[key] !== value) { card.text[key] = value; el.textContent = value }
  }

  private drawCard(s: Step, b: Box | undefined, t: number, frame: Frame) {
    if (!b) return
    const tNode = tNodeOf(s)
    let card = this.cards.get(s.id)
    if (t < tNode) { if (card) card.el.style.display = 'none'; return }
    // built as something else (notes that became a review, or a review whose answers changed): build it again
    if (card && card.shape !== shapeOf(s)) { card.el.remove(); this.cards.delete(s.id); card = undefined }
    if (!card) card = this.makeCard(s, b)
    card.el.style.display = ''
    place(card.el, { left: b.x, top: b.y, width: b.w, height: b.h })
    sizeFrame(card.frame, b.w, b.h)
    const since = t - tNode
    const working = s.state === 'running'
    setFrame(card.frame, since, working ? t : 0)
    card.el.classList.toggle('is-hover', this.flow.hover === s.id)
    card.frame.line.setAttribute('stroke-width', s.id === frame.focusId ? '2.3' : s.kind === 'gate' ? '1.9' : '1.7')
    if (s.kind === 'steer') {
      const [a, c] = card.el.querySelectorAll<HTMLElement>('.wipe')
      this.setText(card, 'sum', card.sum, s.summary ?? '')
      if (a) wipe(a, ease(clamp((since - 0.2) / 0.3)))
      if (c) wipe(c, ease(clamp((since - 0.35) / 0.4)))
      return
    }
    const lk = liveK(s, t)
    setWorking(card.frame, lk, t)
    const titleAt = s.t1 !== undefined ? Math.max(s.t1, tNode) : tNode
    this.setText(card, 'title', card.title, cap(s.title))
    if (card.title) wipe(card.title, ease(clamp((t - titleAt - (titleAt === tNode ? 0.3 : 0)) / 0.35)))
    const words = s.kind === 'gate' ? s.summary ?? '' : working ? `${cap(s.words ?? 'starting')}…` : cap(s.summary ?? '')
    const wordsAt = working ? Math.max(s.tWords ?? 0, tNode) : titleAt
    this.setText(card, 'sum', card.sum, words)
    if (card.sum) wipe(card.sum, ease(clamp((t - wordsAt - (wordsAt === tNode ? 0.45 : 0.05)) / 0.45)))
    if (card.st) {
      card.st.textContent = working ? elapsed(t - s.t0) : s.t1 !== undefined && s.t1 - s.t0 >= 1 ? took(s.t1 - s.t0) : ''
      card.st.style.opacity = String(clamp((since - 0.5) / 0.3))
    }
    if (card.mark) {
      card.mark.innerHTML = s.state === 'running' ? loopSvg(s.lane, t) : s.state === 'failed' ? failSvg() : tickSvg(s.t1 !== undefined ? ease(clamp((t - s.t1) / 0.45)) : 1)
      card.mark.style.opacity = String(clamp((since - 0.3) / 0.2))
    }
    if (card.live) {
      card.live.style.height = `${(LIVE_H * lk).toFixed(1)}px`
      card.live.style.opacity = clamp(lk * 1.4 - 0.2).toFixed(3)
      if (lk > 0) {
        this.setText(card, 'act', card.act, s.action ?? 'Starting…')
        if (card.act) wipe(card.act, ease(clamp((t - Math.max(s.tAction ?? 0, tNode + 0.3)) / 0.35)))
        if (card.bar) card.bar.innerHTML = meterSvg(s.id, s.lane, s.meter, t - tNode, Math.min(132, b.w - 96))
        const [n, of, unit] = s.meter ?? [null, null, '']
        if (card.count) card.count.textContent = n === null ? '' : of ? `${n}/${of} ${unit}` : `${n} ${unit}`
      }
    }
    if (card.clock) {
      const left = gateLeft(s, t)
      if (s.state === 'waiting' && left !== null && typeof s.wait === 'number') card.clock.innerHTML = clockSvg(left, clamp(((s.until ?? t) - t) / s.wait))
      else if (s.state === 'waiting') card.clock.innerHTML = clockSvg(s.paused ? '||' : '?', 1)
      else card.clock.innerHTML = `<g transform="translate(1 1) scale(2)">${s.state === 'failed' ? failSvg() : tickSvg(s.t1 !== undefined ? ease(clamp((t - s.t1) / 0.45)) : 1)}</g>`
      card.clock.style.opacity = String(clamp((since - 0.3) / 0.25))
      const words = gateOptions(s, this.flow.paused)
      card.btns.forEach((btn, i) => {
        const word = cap(words[i]?.word ?? '')
        if (btn.lastChild && btn.lastChild.nodeType === 3 && btn.lastChild.textContent !== word) btn.lastChild.textContent = word
        const f = card!.btnFrames[i]
        if (f) { sizeFrame(f, btn.offsetWidth || 70, 29); setFrame(f, since - 0.55 - i * 0.08) }
        wipe(btn, ease(clamp((since - 0.55 - i * 0.08) / 0.3)))
        btn.disabled = s.state !== 'waiting'
        btn.style.opacity = s.state === 'waiting' ? '' : String(0.3 + 0.7 * (1 - clamp((t - (s.t1 ?? t)) / 0.4)))
      })
    }
  }

  private setTag(tag: Tag, text: string, fill: Fill | null, width: number, since = 2) {
    tag.el.style.display = fill || tag.key === 'task' ? '' : 'none'
    if (tag.text.textContent !== text) tag.text.textContent = text
    if (tag.key === 'task') return
    const want = fill ? `${fill}:${width}` : ''
    if (tag.el.dataset.fill !== want) {
      tag.el.dataset.fill = want
      tag.frame?.el.remove()
      tag.frame = null
      tag.el.style.width = `${width}px`
      if (fill) tag.frame = frame(tag.el, width, 26, { fill, kind: 'tag', key: tag.key + fill })
    }
    if (tag.frame) setFrame(tag.frame, since)
  }

  private drawHeader(frame: Frame) {
    const flow = this.flow
    const t = frame.now
    const info = flow.info
    this.setTag(this.tags.task, info ? cap(info.title) : flow.settings?.workdir ? 'No workflow yet' : 'Pick a folder…', null, 0)
    this.tags.task.el.classList.toggle('is-link', !flow.settings?.workdir)
    const size = (info?.size ?? null) as Size | null
    this.setTag(this.tags.size, size ? cap(size) : '', size ? 'manila' : null, 70)
    const phases = stagesFor(size && ['small', 'medium', 'large'].includes(size) ? size : 'large')
    const stepWords = frame.phase >= 0 ? `${frame.phase + 1}/${phases.length} · ${phases[frame.phase]?.label ?? ''}` : ''
    this.setTag(this.tags.step, stepWords, frame.phase >= 0 ? 'oat' : null, Math.round(36 + stepWords.length * 6.6))
    const gate = frame.gate
    let text = '', fill: Fill | null = null, wiggle = 0
    if (gate) {
      fill = 'gold'
      const left = gateLeft(gate, t)
      text = gate.noAuto ? 'Your yes is needed' : left === null ? 'Waiting for you · paused' : `Waiting for you · carries on in 0:${String(left).padStart(2, '0')}`
      const age = t - tNodeOf(gate)
      wiggle = age > 0 && age < 0.9 ? Math.sin(age * 34) * 3.2 * (1 - age / 0.9) : 0
    } else if (frame.running.length) { fill = 'sheet'; text = `${frame.running.length} working` }
    this.tags.status.el.classList.toggle('is-link', Boolean(gate))
    this.setTag(this.tags.status, text, fill, gate ? (gate.noAuto ? 160 : 270) : 96)
    this.tags.status.el.style.transform = `rotate(${(-1 + wiggle).toFixed(2)}deg)`
    this.setTag(this.tags.pause, flow.paused ? 'Resume' : 'Pause', flow.paused ? 'clay' : 'sheet', 72)
    this.setTag(this.tags.theme, 'Terminal look', 'sheet', 108)
  }

  private drawHeads(frame: Frame) {
    const t = frame.now
    const all = [...frame.steps.values()]
    this.headEls.forEach((h, i) => {
      const who = LANES[i]!
      const mine = all.filter(s => s.lane === who)
      let word = 'idle'
      if (who === 'you') word = frame.gate ? 'your turn' : this.flow.info ? 'watching' : 'idle'
      else if (mine.some(s => s.state === 'running')) word = 'working'
      else if (who === 'claude' && frame.gate && !frame.gate.noAuto) word = this.headW >= 180 ? 'waits on you' : 'waits'
      else if (mine.length) word = this.headW >= 180 ? 'done for now' : 'done'
      if (h.word !== word) { h.before = h.word; h.word = word; h.changed = t; h.state.textContent = word }
      wipe(h.state, ease(clamp((t - h.changed) / 0.3)))
      const busy = (w: string) => w === 'working' || w === 'your turn'
      h.state.classList.toggle('is-busy', busy(word))
      const turn = ease(clamp((t - h.changed) / 0.4))
      const k = busy(word) ? turn : busy(h.before) ? 1 - turn : 0
      setFrame(h.f, 2)
      setWorking(h.f, k * (word === 'your turn' ? 0.7 : 1), t)
    })
  }

  private drawSteer(frame: Frame) {
    const flow = this.flow
    const t = frame.now
    const who = flow.target()
    // while a timed review waits, plain text goes to it
    const review = Boolean(frame.gate && !frame.gate.noAuto && who === 'claude')
    const key = review ? 'review' : who
    if (key !== this.toWho) {
      this.toWho = key as Lane
      this.toFrame?.el.remove()
      this.toEl.innerHTML = review ? `<span class="face">${faceSvg('you', 18)}</span><span>to Review</span>` : `<span class="face">${faceSvg(who, 18)}</span><span>to ${NAME[who]}</span>`
      this.toFrame = frameTag(this.toEl, review ? 'you' : who, review ? 'gold' : undefined)
    }
    if (this.toFrame) setFrame(this.toFrame, 2)
    if (this.input.value !== flow.input) this.input.value = flow.input
    const placeholder = frame.gate?.noAuto ? 'Choose Yes or Not now above' : frame.gate ? 'Type a change to this review…' : 'Steer the work, or @Gemini, @Codex to ask one directly…'
    if (this.input.placeholder !== placeholder) this.input.placeholder = placeholder
    const notice = flow.notice && t - flow.notice.at < 3 ? cap(flow.notice.text) : ''
    if (this.notice.textContent !== notice) this.notice.textContent = notice
    this.notice.style.opacity = notice ? String(clamp(3 - (t - (flow.notice?.at ?? t)))) : '0'
    const press = clamp(1 - (t - this.sentAt) / 0.18)
    this.sendEl.style.transform = `translate(${(press * 2.5).toFixed(2)}px, ${(press * 3).toFixed(2)}px)`
    if (this.sendFrame) { setFrame(this.sendFrame, 2); this.sendFrame.shadow.setAttribute('opacity', (1 - press).toFixed(2)) }
  }

  // ---------------------------------------------------------------- sheet

  private drawSheet(frame: Frame) {
    const flow = this.flow
    const t = frame.now
    const panes: [Pane, string][] = [['detail', 'Step'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['codex', 'Codex'], ['settings', 'Settings']]
    const tabsKey = flow.pane
    if (this.sheetTabs.dataset.on !== tabsKey) {
      this.sheetTabs.dataset.on = tabsKey
      this.sheetTabs.innerHTML = panes.map(([pane, word]) => `<button data-pane="${pane}" class="${pane === flow.pane ? 'on' : ''}">${word}</button>`).join('')
    }
    this.live.style.display = flow.pinned && flow.pane === 'detail' ? '' : 'none'
    if (flow.pane === 'settings') return this.drawSettings()
    if (flow.pane !== 'detail') return this.drawAgent(frame, flow.pane)
    const s = frame.focusId ? frame.steps.get(frame.focusId) : undefined
    if (!s) { this.html('empty', '<div class="d-empty">Each step opens here.</div>'); return }
    const logs = s.logs.filter(e => e.t <= t)
    const run = flow.tab === 'progress' ? null : flow.runDetail(s.run)
    const key = ['step', s.id, logs.length, s.state, s.title, flow.tab, run ? 'run' : '', s.summary].join('|')
    if (key !== this.sheetKey) {
      seedFrom('tab')
      const tabs: [typeof flow.tab, string][] = [['progress', s.kind === 'gate' ? 'Review' : 'Progress'], ['brief', 'Brief'], ['result', 'Result']]
      let body = ''
      if (flow.tab === 'progress') {
        let point = 0
        for (const e of logs) {
          const text = esc(e.text)
          if (e.mark === '>') body += `<div class="l"><span class="k">›</span><span class="brief">${text}</span></div>`
          else if (e.mark === '●') { const [verb = '', ...rest] = e.text.split(' '); body += `<div class="l tool"><span class="k lane-${s.lane}">●</span><span><b>${esc(verb)}</b> ${esc(rest.join(' '))}</span></div>` }
          else if (e.mark === '⎿') body += `<div class="l res">${text}</div>`
          else if (e.mark === '✻') body += `<div class="l think"><span class="k lane-${s.lane}">✱</span><span>${text}</span></div>`
          else if (e.mark === '✓') body += `<div class="l"><span class="k">✓</span><span>${text}</span></div>`
          else if (e.mark === '#') {
            point++
            const [words = '', from = ''] = e.text.replace(/^\s*\d{1,2}\s{2,}/, '').split('|')
            const chips = from.trim().split(/\s+/).filter(Boolean).map(w => `<span class="chip chip-${w === 'G' ? 'gemini' : w === 'X' ? 'codex' : 'claude'}">${esc(w)}</span>`).join('')
            body += `<div class="l pt"><span class="n">${point}</span><span>${esc(words)}</span><span class="who2">${chips}</span></div>`
          } else if (e.mark === 'h') body += `<div class="l h">${text}</div>`
          else if (e.mark === '?') { const [letter = '', q = ''] = e.text.split('|'); body += `<div class="l ch"><b>${esc(letter)}</b><span>${esc(q)}</span></div>` }
          else body += `<div class="l res">${text}</div>`
        }
        if (s.state === 'running') body += `<div class="l now"><svg width="16" height="16" viewBox="0 0 22 22" class="nowmark"></svg><span>${s.lane === 'claude' ? 'Thinking' : s.lane === 'codex' ? 'Working' : 'Planning'}…</span></div>`
      } else {
        const text = flow.tab === 'brief'
          ? run?.brief || logs.filter(e => e.mark === '>').map(e => e.text).join('\n\n') || (s.run ? 'Loading…' : 'No brief.')
          : run?.reply || s.summary || (s.run ? 'Loading…' : s.state === 'running' ? 'Not done yet.' : 'No result.')
        body = `<div class="d-text">${esc(text)}</div>`
      }
      const head = `<div class="who"><span class="face">${faceSvg(s.lane)}</span><b class="wipe">${esc(cap(s.title))}</b><span class="when"></span></div>
        <div class="sub wipe">${esc(cap(s.state === 'running' ? (s.words ?? 'starting') + '…' : s.summary ?? ''))}</div>
        <div class="d-tabs">${tabs.map(([tab, word]) => `<button data-tab="${tab}" class="${tab === flow.tab ? 'on' : ''}">${word}</button>`).join('')}</div>`
      this.html(key, head + `<div class="log">${body}</div>`)
    }
    const when = this.sheetBody.querySelector('.when')
    if (when) when.textContent = s.state === 'running' ? elapsed(t - s.t0) : s.state === 'waiting' ? 'waiting' : s.t1 !== undefined ? took(s.t1 - s.t0) : ''
    const start = Math.max(frame.focusSince, s.t0)
    this.sheetBody.querySelectorAll<HTMLElement>('.who .wipe, .sub').forEach((el, i) => wipe(el, ease(clamp((t - start - i * 0.08) / 0.35))))
    this.sheetBody.querySelectorAll<HTMLElement>('.log .l').forEach((el, i) => {
      const e = logs[i]
      wipe(el, ease(clamp((t - (e ? Math.max(e.t, start + 0.15 + i * 0.03) : start + 0.3)) / 0.4)))
    })
    const nowmark = this.sheetBody.querySelector('.nowmark')
    if (nowmark) nowmark.innerHTML = loopSvg(s.lane, t)
  }

  private html(key: string, html: string) {
    if (this.sheetKey === key) return
    this.sheetKey = key
    this.sheetBody.innerHTML = html
  }

  private drawAgent(frame: Frame, lane: Lane) {
    const t = frame.now
    const mine = [...frame.steps.values()].filter(s => s.lane === lane).sort((a, b) => b.t0 - a.t0)
    const key = ['agent', lane, ...mine.map(s => `${s.id}:${s.state}:${s.logs.filter(e => e.t <= t).length}`)].join('|')
    if (key !== this.sheetKey) {
      const rows = mine.map(s => {
        const recent = s.state === 'running' ? s.logs.filter(e => e.t <= t).slice(-6).map(e => `<div class="l ${e.mark === '●' ? 'tool' : 'res'}">${esc(e.text)}</div>`).join('') : ''
        return `<button class="d-agent-step" data-step="${esc(s.id)}"><span class="mk"><svg viewBox="0 0 22 22" width="18" height="18">${s.state === 'running' ? '' : s.state === 'failed' ? failSvg() : tickSvg(1)}</svg></span><span class="tt"><b>${esc(cap(s.title))}</b><span>${esc(s.state === 'running' ? (s.words ?? '') : s.summary ?? '')}</span></span></button>${recent ? `<div class="log">${recent}</div>` : ''}`
      }).join('')
      this.html(key, `<div class="who"><span class="face">${faceSvg(lane)}</span><b>${NAME[lane]}</b></div>${rows || '<div class="d-empty">Nothing in this flow yet.</div>'}`)
    }
    this.sheetBody.querySelectorAll<SVGSVGElement>('.d-agent-step svg').forEach((svg, i) => {
      const s = mine[i]
      if (s?.state === 'running') svg.innerHTML = loopSvg(lane, t)
    })
  }

  private drawSettings() {
    const flow = this.flow
    const st = flow.settings
    if (!st) return
    const key = ['settings', JSON.stringify(st), flow.flows.length, flow.info?.id].join('|')
    if (key === this.sheetKey) return
    const row = (label: string, value: string, act: string, extra = '') => `<button class="d-set" data-act="${act}" ${extra}><span>${esc(label)}</span><b>${esc(value)}</b></button>`
    let html = '<div class="who"><b>Settings</b></div>'
    html += row('Folder', st.workdir ?? 'None', 'folder')
    for (const path of st.recent.filter(p => p !== st.workdir).slice(0, 4)) html += row('', path, 'recent', `data-value="${esc(path)}"`)
    html += row('Look', st.theme === 'cli' ? 'Terminal' : 'Drawn', 'theme')
    html += row('Companion', st.companion === 'auto' ? 'Shows while work runs' : 'Off', 'companion')
    html += row('On top', st.pinned ? 'Yes' : 'No', 'pin')
    html += row('Codex model', st.codexModel, 'model')
    html += row('Codex effort', st.efforts.codex ?? 'Default', 'codex-effort')
    html += row('Codex edits', st.mode === 'workspace-write' ? 'May edit files' : 'Read only', 'mode')
    html += row('Gemini effort', st.efforts.gemini ?? 'Default', 'gemini-effort')
    if (st.bashError) html += `<div class="d-empty">${esc(st.bashError)}</div>`
    if (flow.flows.length > 1) {
      html += '<div class="d-sub-h">Flows</div>'
      for (const one of flow.flows.slice().reverse().slice(0, 6)) html += row(new Date(one.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), one.title, 'flow', `data-value="${esc(one.id)}"${one.id === flow.info?.id ? ' data-on="1"' : ''}`)
    }
    this.html(key, html)
  }
}

/** The steer box's "to …" tag, drawn in the colour of whoever it goes to. */
function frameTag(el: HTMLElement, who: Lane, fill?: Fill): InkFrame {
  el.querySelector('.frame')?.remove()
  return frame(el, 112, 30, { fill: fill ?? who, kind: 'tag', key: 'to' + (fill ?? who) })
}
