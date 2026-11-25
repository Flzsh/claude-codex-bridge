export const LANES = ['you', 'claude', 'gemini', 'codex'] as const
export type Lane = typeof LANES[number]
export const LANE: Record<Lane, number> = { you: 0, claude: 1, gemini: 2, codex: 3 }
export const PHASES = ['ask', 'two plans', 'merge', 'decide', 'build', 'review', 'check & ship']

const KINDS = ['step', 'gate', 'steer', 'flow'] as const
const STATES = ['running', 'done', 'failed', 'waiting'] as const
const ANSWERS = ['approve', 'pause', 'resume', 'steer', 'decline'] as const
const SIZES = ['small', 'medium', 'large'] as const

export type FlowEvent = {
  t: number
  id?: string
  flow?: string
  size?: typeof SIZES[number]
  lane?: Lane
  phase?: number
  kind?: typeof KINDS[number]
  state?: typeof STATES[number]
  title?: string
  summary?: string
  progress?: string
  after?: string[]
  to?: Lane
  wait?: number
  until?: number
  paused?: boolean
  noAuto?: boolean
  auto?: boolean
  meter?: [n: number, total: number | null, unit: string]
  log?: [mark: string, text: string]
  run?: string
  answer?: typeof ANSWERS[number]
  gate?: string
  text?: string
}

export type Step = Omit<FlowEvent, 't' | 'log'> & {
  id: string
  lane: Lane
  after: string[]
  t0: number
  t1?: number
  tState: number
  tProgress: number
  tMeter?: number
  words?: string
  tWords?: number
  action?: string
  tAction?: number
  result?: string | null
  tResult?: number
  logs: { t: number; mark: string; text: string }[]
  path?: [line: number, x: number][]
  tNode?: number
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some(candidate => candidate === value)
}

const TEXT_LIMITS = { title: 200, summary: 500, progress: 500, text: 500 } as const

/** Parse complete JSONL records and preserve file order when timestamps tie. */
export function parseFlow(text: string): FlowEvent[] {
  const events: FlowEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let raw: unknown
    try { raw = JSON.parse(line) } catch { continue }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const source = raw as Record<string, unknown>
    if (!isNumber(source.t)) continue
    const event: FlowEvent = { t: source.t }
    for (const key of ['id', 'flow', 'run', 'gate'] as const) {
      if (isString(source[key])) event[key] = source[key]
    }
    for (const key of ['title', 'summary', 'progress', 'text'] as const) {
      const value = source[key]
      if (isString(value)) event[key] = value.slice(0, TEXT_LIMITS[key])
    }
    for (const key of ['phase', 'wait', 'until'] as const) {
      if (isNumber(source[key])) event[key] = source[key]
    }
    for (const key of ['noAuto', 'auto', 'paused'] as const) {
      if (typeof source[key] === 'boolean') event[key] = source[key]
    }
    if (oneOf(LANES, source.lane)) event.lane = source.lane
    if (oneOf(LANES, source.to)) event.to = source.to
    if (oneOf(KINDS, source.kind)) event.kind = source.kind
    if (oneOf(STATES, source.state)) event.state = source.state
    if (oneOf(ANSWERS, source.answer)) event.answer = source.answer
    if (oneOf(SIZES, source.size)) event.size = source.size
    if (Array.isArray(source.after)) event.after = source.after.filter(isString)

    const { log, meter } = source
    if (Array.isArray(log) && log.length === 2 && isString(log[0]) && isString(log[1])) {
      event.log = [log[0], log[1].slice(0, 2000)]
    }
    if (Array.isArray(meter) && meter.length === 3 && isNumber(meter[0]) &&
        (meter[1] === null || isNumber(meter[1])) && isString(meter[2])) {
      event.meter = [meter[0], meter[1], meter[2]]
    }
    events.push(event)
  }
  return events.sort((a, b) => a.t - b.t)
}

const PATCH_FIELDS = [
  'lane', 'phase', 'kind', 'state', 'title', 'summary', 'progress', 'after', 'to',
  'wait', 'until', 'noAuto', 'auto', 'meter', 'run', 'paused', 'flow', 'size', 'text', 'answer', 'gate',
] as const

function patchStep(step: Partial<FlowEvent>, event: FlowEvent) {
  function patch<K extends typeof PATCH_FIELDS[number]>(key: K) {
    if (event[key] !== undefined) step[key] = event[key]
  }
  for (const key of PATCH_FIELDS) patch(key)
}

/** Every step as it stands at time t. Events are in chronological order. */
export function fold(events: readonly FlowEvent[], t: number): Map<string, Step> {
  const steps = new Map<string, Step>()
  for (const e of events) {
    if (e.t > t) break
    if (!e.id) continue
    let s = steps.get(e.id)
    if (!s) {
      // A log or meter can arrive before its step declaration.
      s = { id: e.id, lane: e.lane ?? 'claude', t0: e.t, after: [], logs: [], tProgress: e.t, tState: e.t }
      steps.set(e.id, s)
    }
    const was = s.state
    patchStep(s, e)
    if (e.paused) delete s.until
    if (e.progress !== undefined) {
      s.tProgress = e.t
      // Counts go on the meter. Keep the last progress that was only words.
      if (!/[0-9]/.test(e.progress)) {
        s.words = e.progress
        s.tWords = e.t
      }
    }
    if (e.meter !== undefined) s.tMeter = e.t
    if (e.log) {
      const [mark, text] = e.log
      if (mark === '●') {
        s.action = text
        s.tAction = e.t
        s.result = null
      }
      if (mark === '⎿') {
        s.result = text
        s.tResult = e.t
      }
      s.logs.push({ t: e.t, mark, text })
    }
    if (e.state !== undefined && e.state !== was) {
      s.tState = e.t
      if (e.state === 'done' || e.state === 'failed') s.t1 = e.t
    }
  }
  return steps
}

export const U = 1, D = 2, L = 4, R = 8
export const EDGE_STEP = 0.014 // seconds per cell as a line grows
export const GAP = 8 // columns between lanes

type EdgeCell = { x: number; bits: number; lane: Lane; trunk: boolean; t: number }
type Edge = [line: number, x: number, bits: number, lane: Lane, trunk?: boolean]
type LineBase = { t0: number; cells: EdgeCell[] }
export type GraphLine = LineBase & (
  | { kind: 'gap' | 'conn' }
  | { kind: 'head'; phase: number }
  | { kind: 'step' | 'live' | 'prompt' | 'count'; step: Step }
)

/** Arrange the graph rows and time each edge cell from parent to child. */
export function layout(steps: ReadonlyMap<string, Step>) {
  const list = [...steps.values()]
  const reach = (s: Step) => {
    let max = 0
    for (const id of s.after) {
      const parent = steps.get(id)
      if (parent) max = Math.max(max, Math.abs(LANE[s.lane] - LANE[parent.lane]))
    }
    return max
  }
  list.sort((a, b) => a.t0 - b.t0 || reach(b) - reach(a))
  const lines: GraphLine[] = []
  const at = new Map<string, { conn: number; line: number }>()
  let phase: number | undefined
  for (const s of list) {
    if (s.phase !== undefined && s.phase !== phase) {
      if (phase !== undefined) lines.push({ kind: 'gap', t0: s.t0, cells: [] })
      lines.push({ kind: 'head', phase: s.phase, t0: s.t0, cells: [] })
      phase = s.phase
    }
    const cross = s.after.some(id => {
      const parent = steps.get(id)
      return parent && parent.lane !== s.lane
    })
    const conn = cross ? lines.push({ kind: 'conn', t0: s.t0, cells: [] }) - 1 : -1
    const line = lines.push({ kind: 'step', step: s, t0: s.t0, cells: [] }) - 1
    at.set(s.id, { conn, line })
    if (s.state === 'running') lines.push({ kind: 'live', step: s, t0: s.t0, cells: [] })
    if (s.kind === 'gate') {
      lines.push({ kind: 'prompt', step: s, t0: s.t0, cells: [] })
      if (s.state === 'waiting' && !s.noAuto) lines.push({ kind: 'count', step: s, t0: s.t0, cells: [] })
    }
  }
  for (const child of list) {
    const to = at.get(child.id)!
    let longest = 0
    delete child.path
    for (const id of child.after) {
      const parent = steps.get(id)
      const from = at.get(id)
      if (!parent || !from) continue
      const pl = LANE[parent.lane], cl = LANE[child.lane]
      const cells: Edge[] = []
      if (pl === cl || to.conn < 0) {
        for (let y = from.line + 1; y < to.line; y++) cells.push([y, pl * GAP, U | D, parent.lane])
      } else {
        for (let y = from.line + 1; y < to.conn; y++) cells.push([y, pl * GAP, U | D, parent.lane])
        const dir = cl > pl ? 1 : -1
        const across = child.after.length > 1 ? parent.lane : child.lane
        cells.push([to.conn, pl * GAP, U | (dir > 0 ? R : L), parent.lane, true])
        for (let x = pl * GAP + dir; x !== cl * GAP; x += dir) cells.push([to.conn, x, L | R, across])
        cells.push([to.conn, cl * GAP, (dir > 0 ? L : R) | D, across])
      }
      cells.forEach(([y, x, bits, lane, trunk], i) => {
        lines[y]!.cells.push({ x, bits, lane, trunk: trunk || bits === (U | D), t: child.t0 + i * EDGE_STEP })
      })
      if (cells.length >= longest) child.path = cells.map(([y, x]) => [y, x])
      longest = Math.max(longest, cells.length)
    }
    child.tNode = child.t0 + longest * EDGE_STEP
  }
  return { lines, at }
}

/** The visible join at column x, giving the trunk lane precedence at crossings. */
export function graphCell(line: GraphLine, x: number, t: number) {
  let bits = 0
  let lane: Lane | undefined, trunkLane: Lane | undefined
  for (const cell of line.cells) {
    if (cell.x !== x || cell.t > t) continue
    bits |= cell.bits
    if (cell.trunk) trunkLane ??= cell.lane
    lane ??= cell.lane
  }
  return bits && lane ? { bits, lane: trunkLane ?? lane } : null
}

/** The step the detail pane follows, and when it took over. */
export function focusAt(events: readonly FlowEvent[], steps: ReadonlyMap<string, Step>, t: number) {
  let focus: string | null = null
  let since = 0
  const pick = (when: number) => {
    let best: Step | undefined
    for (const s of steps.values()) {
      if (s.t0 > when || (s.t1 !== undefined && s.t1 <= when) || s.kind === 'steer') continue
      if (s.kind === 'gate') return s.id
      if (!best || s.t0 > best.t0 || (s.t0 === best.t0 && LANE[s.lane] > LANE[best.lane])) best = s
    }
    return best?.id
  }
  for (const e of events) {
    if (e.t > t) break
    if (!e.id || (!e.state && !e.lane)) continue
    const next: string | null = pick(e.t) ?? focus
    if (next !== focus) {
      focus = next
      since = e.t
    }
  }
  return { id: focus, since }
}

/** Flows in start order, with their original start records. */
export function flows(events: readonly FlowEvent[]): { id: string; start: FlowEvent }[] {
  const starts = new Map<string, FlowEvent>()
  for (const e of events) {
    if (e.flow && e.kind === 'flow' && e.state !== 'done' && !starts.has(e.flow)) starts.set(e.flow, e)
  }
  return Array.from(starts, ([id, start]) => ({ id, start }))
}

export function currentFlow(events: readonly FlowEvent[]): string | null {
  return flows(events).at(-1)?.id ?? null
}

export function ofFlow(events: readonly FlowEvent[], id: string | null): FlowEvent[] {
  if (id !== null) return events.filter(e => e.flow === id)
  return currentFlow(events) === null ? events.filter(e => !e.flow) : []
}

export function paused(events: readonly FlowEvent[], t: number): boolean {
  let held = false
  for (const e of events) {
    if (e.t > t) break
    if (e.answer === 'pause' || e.answer === 'resume') held = e.answer === 'pause'
  }
  return held
}
