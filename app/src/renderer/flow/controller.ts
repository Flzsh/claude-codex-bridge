// What both themes share: the flow's events, the app's settings, what is
// selected, and the actions the owner can take. A theme only draws this and
// calls these actions; nothing here knows how it looks.

import { fold, focusAt, LANE, type FlowEvent, type Lane, type Step } from '../../../../core/flow'
import type { Workflow } from '../../../../core/workflow'

/** How many events have happened by t (events are sorted by time). */
function countBy(events: readonly FlowEvent[], t: number): number {
  let lo = 0, hi = events.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if ((events[mid]?.t ?? Infinity) <= t) lo = mid + 1; else hi = mid }
  return lo
}

export type Theme = 'cli' | 'drawn'
export type Provider = 'codex' | 'gemini'
export type GateAnswer = 'approve' | 'decline' | 'steer'
export type FlowInfo = { id: string; title: string; size: string | null; t: number; state: string | null }
export type FlowPayload = { flow: FlowInfo | null; events: FlowEvent[]; paused: boolean; flows: FlowInfo[] }
export type Settings = {
  workdir: string | null
  recent: string[]
  pinned: boolean
  codexModel: string
  models: string[]
  mode: 'read-only' | 'workspace-write'
  efforts: Record<Provider, string | null>
  effortChoices: Record<Provider, string[]>
  companion: 'auto' | 'always' | 'off'
  theme: Theme
  /** The Claude Code pane's ground in the terminal look. */
  pane: 'dark' | 'white'
  bashError: string
  /** What became of the last message the box sent Claude. */
  delivery: { route: 'claude-start' | 'claude-next-step'; at: number; state: 'waiting' | 'read' | 'nobody' } | null
  /** A Claude Code session with the plugin is open in this folder. */
  claudeHere: boolean
  /** That session is at work (thinking or using a tool). */
  claudeBusy?: boolean
  /** The owner's steps for each size (the step editor's), else the defaults. */
  workflow?: Workflow
}
export type RunDetail = { brief: string; reply: string; logTail: string }

/** A tab: one workflow, in whatever folder it runs, or this folder when nothing of it runs. */
export type TabInfo = {
  key: string
  flow: string | null
  workdir: string
  title: string
  folder: string
  mark: 'work' | 'wait' | 'pause' | 'done' | 'quiet' | 'idle'
  active: boolean
}

/** The window's door to the main process (preload.ts). */
export type BridgeApi = {
  state(): Promise<Settings>
  flow(): Promise<FlowPayload>
  on(event: 'state' | 'flow' | 'tabs' | 'ask', listener: (payload: unknown) => void): () => void
  tabs(): Promise<TabInfo[]>
  selectTab(key: string): Promise<{ error?: string }>
  closeTab(key: string): Promise<unknown>
  reopenTab(): Promise<{ error?: string }>
  setWorkflow(workflow: Workflow): Promise<{ error?: string }>
  resetWorkflow(): Promise<unknown>
  answerGate(gate: string, answer: GateAnswer, text?: string, t0?: number): Promise<{ ok?: boolean; taken?: boolean; error?: string }>
  setPaused(paused: boolean): Promise<{ ok?: boolean; error?: string }>
  steer(text: string): Promise<{ ok?: boolean; error?: string; route?: string }>
  setTheme(theme: Theme): Promise<void>
  showFlow(id: string | null): Promise<void>
  run(id: string): Promise<RunDetail>
  pickFolder(): Promise<string | null | { error: string }>
  setWorkdir(path: string): Promise<{ error?: string }>
  setEffort(provider: Provider, effort: string | null): Promise<unknown>
  setModel(model: string): Promise<void>
  setMode(mode: string): Promise<void>
  pin(): Promise<void>
  companionToggle(): Promise<void>
  paneToggle(): Promise<void>
  openFolder(): Promise<void>
  stop(provider: Provider): Promise<void>
}

export type Pane = 'detail' | 'claude' | 'gemini' | 'codex' | 'settings'
export type Tab = 'progress' | 'brief' | 'result'

/** One frame's view of the flow, worked out once and drawn by a theme. */
export type Frame = {
  now: number
  steps: Map<string, Step>
  focusId: string | null
  focusSince: number
  gate: Step | null
  running: Step[]
  phase: number
}

export const now = () => Date.now() / 1000

/** What became of a message to Claude, in a few words. */
export function deliveryWords(d: NonNullable<Settings['delivery']>): string {
  if (d.route === 'claude-next-step') return d.state === 'read' ? '✓ claude read your note' : 'sent: claude reads it at its next step'
  if (d.state === 'read') return '✓ claude got it and starts the workflow'
  if (d.state === 'nobody') return 'no claude code session took it: open claude code in this folder'
  return 'sent: waiting for claude code in this folder'
}

export class Flow {
  /** The flow's events, with Claude's working step added while it works between steps. */
  events: FlowEvent[] = []
  /** The flow's events as the file has them. */
  private raw: FlowEvent[] = []
  info: FlowInfo | null = null
  flows: FlowInfo[] = []
  paused = false
  settings: Settings | null = null
  /** The step the owner picked; null follows whatever is live. */
  pinned: string | null = null
  hover: string | null = null
  pane: Pane = 'detail'
  tab: Tab = 'progress'
  /** Which answer is highlighted in an open gate's prompt; -1 until the owner moves to one, so a stray Enter answers nothing. */
  choice = -1
  /** The review's countdown was held because the owner started a steer; it resumes when they send or clear it. */
  heldForSteer = false
  /** The review the highlighted answer belongs to; another review starts with nothing highlighted. */
  private choiceGate = ''
  private holdChain: Promise<unknown> = Promise.resolve()
  /** Folds by how many events have happened: the same count gives the same steps, so frames reuse them. */
  private folds = new Map<number, { steps: Map<string, Step>; focus: { id: string | null; since: number } }>()
  private foldsFor: FlowEvent[] = []
  input = ''
  /** The window's tabs, in order. */
  tabs: TabInfo[] = []
  /** The step editor is open (from the settings). */
  stepsOpen = false
  notice: { text: string; at: number } | null = null
  private runs = new Map<string, RunDetail | 'loading'>()
  private listeners = new Set<() => void>()

  constructor(readonly api: BridgeApi) {}

  async start() {
    this.api.on('state', payload => {
      const before = this.settings?.delivery
      this.settings = payload as Settings
      this.events = this.withClaude()
      const d = this.settings.delivery
      // a message's fate, said once when it changes
      if (d && before && d.at === before.at && d.state !== before.state) this.say(deliveryWords(d))
      this.changed()
    })
    this.api.on('flow', payload => this.takeFlow(payload as FlowPayload))
    this.api.on('ask', payload => this.askAgent(payload === 'gemini' ? 'gemini' : 'codex'))
    this.api.on('tabs', payload => {
      this.tabs = payload as TabInfo[]
      this.changed()
    })
    this.tabs = await this.api.tabs().catch(() => [])
    this.settings = await this.api.state()
    this.takeFlow(await this.api.flow())
  }

  /** Points the window at a tab. */
  selectTab(key: string) {
    void this.api.selectTab(key).then(result => {
      if (result?.error) this.say(result.error)
    })
  }

  closeTab(key: string) {
    void this.api.closeTab(key)
  }

  openSteps() {
    this.stepsOpen = true
    this.changed()
  }

  closeSteps() {
    this.stepsOpen = false
    this.changed()
  }

  /** Saves the owner's steps (main checks them against the rules and sends them back). */
  saveWorkflow(workflow: Workflow): Promise<void> {
    return this.api.setWorkflow(workflow).then(result => {
      if (result?.error) this.say(result.error)
    })
  }

  resetWorkflow() {
    void this.api.resetWorkflow().then(result => {
      const error = (result as { error?: string } | undefined)?.error
      if (error) this.say(error)
    })
  }

  /** The tab closed last, back (Ctrl+Shift+T). */
  reopenTab() {
    void this.api.reopenTab().then(result => {
      if (result?.error) this.say(result.error)
    })
  }

  /** The tab `step` places from the one shown (Ctrl+Tab, Ctrl+Shift+Tab), round the ends. */
  nextTab(step: number) {
    const count = this.tabs.length
    if (count < 2) return
    const at = Math.max(0, this.tabs.findIndex(tab => tab.active))
    this.selectTab(this.tabs[(at + step + count) % count]!.key)
  }

  /** The tab at a place, 0 first (Ctrl+1..8); Ctrl+9 is the last, as in a browser. */
  tabAt(index: number) {
    const tab = index === 8 ? this.tabs[this.tabs.length - 1] : this.tabs[index]
    if (tab) this.selectTab(tab.key)
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed() {
    for (const listener of this.listeners) listener()
  }

  private takeFlow(payload: FlowPayload) {
    const before = this.info?.id
    this.raw = payload.events
    this.info = payload.flow
    this.flows = payload.flows
    this.paused = payload.paused
    this.events = this.withClaude()
    if (before !== this.info?.id) { this.pinned = null; this.choice = -1 }
    this.changed()
  }

  /**
   * Between steps, while Claude works and nothing else runs, the flow ends in a working step of
   * Claude's own, so the window never stands still while Claude does. It starts at the last
   * event, so its motion does not restart while it lasts; the next real step takes its place.
   */
  private withClaude(): FlowEvent[] {
    const raw = this.raw
    if (!this.settings?.claudeBusy || this.paused || !this.info || this.info.state === 'done' || !raw.length) return raw
    const at = now()
    for (const step of fold(raw, at).values()) if (step.state === 'running' || step.state === 'waiting') return raw
    const last = [...raw].reverse().find(e => typeof e.id === 'string' && typeof e.lane === 'string' && e.kind !== 'steer')
    const phase = [...raw].reverse().find(e => typeof e.phase === 'number')?.phase
    const t = (raw[raw.length - 1]?.t ?? at) + 0.001
    const working: FlowEvent = { t, flow: this.info.id, id: '~claude', lane: 'claude', kind: 'step', state: 'running', title: 'working on the next step', ...(last?.id ? { after: [last.id] } : {}), ...(typeof phase === 'number' ? { phase } : {}) }
    return [...raw, working]
  }

  /** The steps as they stand at t, reused while no new event has happened. */
  foldAt(at: number) {
    if (this.foldsFor !== this.events) { this.folds.clear(); this.foldsFor = this.events }
    const k = countBy(this.events, at)
    let hit = this.folds.get(k)
    if (!hit) {
      const steps = fold(this.events, at)
      hit = { steps, focus: focusAt(this.events, steps, at) }
      if (this.folds.size > 12) this.folds.clear()
      this.folds.set(k, hit)
    }
    return hit
  }

  frame(at = now()): Frame {
    const { steps, focus } = this.foldAt(at)
    const pinned = this.pinned && steps.has(this.pinned) ? this.pinned : null
    let gate: Step | null = null
    const running: Step[] = []
    let phase = -1
    for (const s of steps.values()) {
      if (s.state === 'waiting' && s.kind === 'gate') gate = s
      if (s.state === 'running' && s.kind !== 'gate' && s.kind !== 'steer') running.push(s)
      if (typeof s.phase === 'number') phase = Math.max(phase, s.phase)
    }
    running.sort((a, b) => b.t0 - a.t0 || LANE[b.lane] - LANE[a.lane])
    const gateKey = gate ? `${gate.id}@${gate.t0}` : ''
    if (gateKey !== this.choiceGate) {
      this.choiceGate = gateKey
      this.choice = -1
      if (this.heldForSteer) void this.release()
    }
    return { now: at, steps, focusId: pinned ?? focus.id, focusSince: pinned ? 0 : focus.since, gate, running, phase }
  }

  // ---------------------------------------------------------------- picking

  select(id: string | null) {
    this.pinned = id && id !== this.pinned ? id : null
    this.pane = 'detail'
    this.tab = 'progress'
    this.changed()
  }

  setPane(pane: Pane) {
    this.pane = pane
    this.changed()
  }

  setTab(tab: Tab) {
    this.tab = tab
    this.changed()
  }

  /** A run's brief and reply, fetched once when a step that is a run is opened. */
  runDetail(id: string | undefined): RunDetail | null {
    if (!id) return null
    const known = this.runs.get(id)
    if (known === 'loading') return null
    if (known) return known
    this.runs.set(id, 'loading')
    void this.api.run(id).then(detail => { this.runs.set(id, detail); this.changed() }, () => this.runs.delete(id))
    return null
  }

  /** Forget a run's cached detail (it finished since). */
  refreshRun(id: string) {
    this.runs.delete(id)
  }

  // ---------------------------------------------------------------- acting

  say(text: string) {
    this.notice = { text, at: now() }
    this.changed()
  }

  async answer(gate: Step, answer: GateAnswer, text?: string) {
    const result = await this.api.answerGate(gate.id, answer, text, gate.t0)
    if (result.error) this.say(result.error)
    else if (result.taken) this.say('already answered')
    else this.say(answer === 'approve' ? 'approved' : answer === 'decline' ? 'declined' : 'change sent')
    this.choice = -1
    if (this.heldForSteer) await this.release()
  }

  async togglePause() {
    const pausing = !this.paused
    const result = await this.api.setPaused(pausing)
    if (result.error) this.say(result.error)
    else this.say(pausing ? 'paused: holds at the next step' : 'resumed')
    this.heldForSteer = false
  }

  /** The owner started typing a change for a timed review: hold its countdown so it cannot run out mid-sentence. */
  holdForSteer(gate: Step | null) {
    if (!gate || gate.noAuto || this.paused || this.heldForSteer) return this.holdChain
    this.heldForSteer = true
    // one change at a time, in order: a quick hold-then-release never ends paused
    this.holdChain = this.holdChain.then(() => this.api.setPaused(true)).catch(() => undefined)
    return this.holdChain
  }

  /** The held countdown goes on again (the change was sent, the box cleared, or the review closed). */
  release() {
    if (!this.heldForSteer) return this.holdChain
    this.heldForSteer = false
    this.holdChain = this.holdChain.then(() => this.api.setPaused(false)).catch(() => undefined)
    return this.holdChain
  }

  /** The steer box changed: an emptied box lets a held review go on. */
  typed(text: string, gate: Step | null) {
    this.input = text
    if (text.trim()) void this.holdForSteer(gate)
    else void this.release()
  }

  /** The steer box: an open gate takes plain text as its steer; otherwise main routes it. */
  async send(gate: Step | null) {
    const text = this.input.trim()
    if (!text) return
    this.input = ''
    this.changed()
    // A timed review takes plain text as its change; a review that needs a real yes does not (it goes to Claude as a steer).
    if (gate && !gate.noAuto && !/^@(codex|gemini)\b/i.test(text)) return this.answer(gate, 'steer', text)
    const result = await this.api.steer(text)
    if (result.error) { this.input = text; this.say(result.error); return }
    void this.release()
    const route = result.route ?? ''
    this.say(
      route === 'claude-next-step'
        ? 'sent: claude reads it at its next step'
        : route === 'claude-start'
          ? this.settings?.claudeHere ? 'sent: claude starts the workflow' : 'sent: waiting for claude code in this folder'
          : `asked ${route}`,
    )
  }

  /** Who the steer box sends to, from its first word. */
  target(): Lane {
    const at = this.input.match(/^@(codex|gemini)\b/i)
    return at ? (at[1]!.toLowerCase() as Lane) : 'claude'
  }

  private boxListeners = new Set<() => void>()
  /** The box's text set from outside ("Ask Codex" in the Claude Code pane): each look puts it in
   * its own field. */
  onBox(fn: () => void): () => void {
    this.boxListeners.add(fn)
    return () => this.boxListeners.delete(fn)
  }

  /** An agent's page, the box addressed to it, keeping what is typed. */
  askAgent(who: 'codex' | 'gemini') {
    this.pane = who
    this.input = `@${who} ` + this.input.replace(/^@(codex|gemini)\b\s*/i, '')
    for (const fn of this.boxListeners) fn()
    this.changed()
  }

  /** Tab: claude, then @codex, then @gemini, keeping what is typed. */
  cycleTarget() {
    const body = this.input.replace(/^@(codex|gemini)\b\s*/i, '')
    const next = { claude: '@codex ', codex: '@gemini ', gemini: '', you: '' }[this.target()]
    this.input = next + body
    this.changed()
  }

  async setTheme(theme: Theme) {
    await this.api.setTheme(theme)
  }
}

/** The options an open gate offers, and what each answers. */
export function gateOptions(gate: Step, paused = false): { word: string; answer: GateAnswer | 'pause' | 'focus' }[] {
  return gate.noAuto
    ? [{ word: 'yes', answer: 'approve' }, { word: 'not now', answer: 'decline' }]
    : [{ word: 'approve', answer: 'approve' }, { word: paused ? 'resume' : 'pause', answer: 'pause' }, { word: 'steer', answer: 'focus' }, { word: 'decline', answer: 'decline' }]
}

/** Seconds left on an open gate, or null when it does not carry on by itself (or is paused). */
export function gateLeft(gate: Step, at: number): number | null {
  if (gate.noAuto || typeof gate.until !== 'number' || typeof gate.wait !== 'number') return null
  return Math.max(0, Math.ceil(gate.until - at))
}
