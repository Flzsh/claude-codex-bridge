import { describe as group, expect, test } from 'claude-code/testing'

import { currentFlow, D, flows, focusAt, fold, GAP, graphCell, L, layout, ofFlow, parseFlow, paused, R, U } from './flow'
import type { FlowEvent } from './flow'

// An excerpt of the approved design prototype's timeline, including its tied starts, fork, merge and gates.
const demo: FlowEvent[] = [
  { t: 3.3, id: 'ask', lane: 'you', phase: 0, state: 'done', title: 'asked' },
  { t: 3.8, id: 'size', lane: 'claude', phase: 0, after: ['ask'], state: 'running', title: 'sizing the work', progress: 'reading the request' },
  { t: 7, id: 'size', state: 'done', title: 'sized the work' },
  { t: 7.4, id: 'plang', lane: 'gemini', phase: 1, after: ['size'], state: 'running', title: 'writing its own plan', progress: 'reading the project' },
  { t: 7.4, id: 'planc', lane: 'claude', phase: 1, after: ['size'], state: 'running', title: 'writing a plan', progress: 'lanes, rows, joins' },
  { t: 7.5, id: 'planc', log: ['●', 'Read app/src/main/main.ts'] },
  { t: 7.9, id: 'planc', log: ['⎿', '807 lines'] },
  { t: 9.4, id: 'planc', meter: [0, null, 'points'] },
  { t: 9.8, id: 'planc', progress: '6 points' },
  { t: 10.6, id: 'planc', log: ['●', 'Read core/console.ts'] },
  { t: 15.5, id: 'planc', state: 'done', title: 'wrote a plan' },
  { t: 17, id: 'plang', state: 'done', title: 'wrote its own plan' },
  { t: 17.4, id: 'merge', lane: 'claude', phase: 2, after: ['planc', 'plang'], state: 'running', title: 'merging the plans' },
  { t: 20.5, id: 'merge', state: 'done', title: 'merged the plans' },
  { t: 21, id: 'gate', lane: 'you', phase: 3, kind: 'gate', after: ['merge'], state: 'waiting', title: 'review the plan', wait: 30, until: 31 },
  { t: 31, id: 'gate', state: 'done', title: 'approved the plan', auto: true },
]

group('flow JSONL', () => {
  test('skips malformed records and sorts ties in file order', () => {
    const parsed = parseFlow('\n{"t":3,"id":"a"}\ntruncated {\nnull\n[]\n{"t":"1"}\n{"t":1e309}\n{"id":"none"}\n{"t":1,"id":"b"}\n{"t":3,"id":"c"}\n')
    expect(parsed.map(e => e.id)).toEqual(['b', 'a', 'c'])
  })

  test('drops unsupported fields and values and clamps display strings', () => {
    const line = JSON.stringify({ t: 1, lane: 'other', state: 'idle', kind: 'unknown', extra: 'x', after: ['a', 2],
      title: 'a'.repeat(201), summary: 'b'.repeat(501), progress: 'c'.repeat(501), text: 'd'.repeat(501), log: ['#', 'e'.repeat(2001)] })
    expect(parseFlow(line)).toEqual([{ t: 1, title: 'a'.repeat(200), summary: 'b'.repeat(500), progress: 'c'.repeat(500),
      text: 'd'.repeat(500), after: ['a'], log: ['#', 'e'.repeat(2000)] }])
  })
})

group('folding the flow', () => {
  test('tracks progress, words, meter, and the current action and result', () => {
    const result = fold(demo, 10).get('planc')
    expect(result?.progress).toBe('6 points')
    expect(result?.tProgress).toBe(9.8)
    expect(result?.words).toBe('lanes, rows, joins')
    expect(result?.tWords).toBe(7.4)
    expect(result?.meter).toEqual([0, null, 'points'])
    expect(result?.tMeter).toBe(9.4)
    expect(result?.action).toBe('Read app/src/main/main.ts')
    expect(result?.tAction).toBe(7.5)
    expect(result?.result).toBe('807 lines')
    expect(result?.tResult).toBe(7.9)
    expect(fold(demo, 11).get('planc')?.result).toBe(null)
  })

  test('records terminal time on a state change and ignores answers without ids', () => {
    const events: FlowEvent[] = [...demo, { t: 32, answer: 'approve', gate: 'gate' }, { t: 33, id: 'gate', state: 'done' },
      { t: 34, id: 'build', lane: 'codex', state: 'running', run: 'run-1' }, { t: 35, id: 'build', state: 'failed' }]
    expect(fold(events, 30).get('gate')?.t1).toBe(undefined)
    const steps = fold(events, 35)
    expect(steps.size).toBe(7)
    expect(steps.get('gate')?.t1).toBe(31)
    expect(steps.get('gate')?.tState).toBe(31)
    expect(steps.get('build')?.t1).toBe(35)
    expect(steps.get('build')?.run).toBe('run-1')
  })

  test('clears a paused gate deadline until the gate resumes', () => {
    const events: FlowEvent[] = [...demo.filter(e => e.t < 31), { t: 23, id: 'gate', paused: true },
      { t: 25, id: 'gate', paused: false, until: 55 }]
    expect(fold(events, 24).get('gate')?.until).toBe(undefined)
    expect(fold(events, 25).get('gate')?.until).toBe(55)
  })
})

group('flow graph', () => {
  test('reveals fork and merge joins with the prototype lane colours', () => {
    const steps = fold(demo, 18)
    const { lines, at } = layout(steps)
    const fork = lines[at.get('plang')!.conn]!
    const merge = lines[at.get('merge')!.conn]!
    expect(fork.kind).toBe('conn')
    expect(graphCell(fork, 2 * GAP, 7.4)).toBe(null)
    expect(graphCell(fork, GAP, 18)).toEqual({ bits: U | D | R, lane: 'claude' })
    expect(graphCell(fork, GAP + 1, 18)).toEqual({ bits: L | R, lane: 'gemini' })
    expect(graphCell(fork, 2 * GAP, 18)).toEqual({ bits: L | D, lane: 'gemini' })
    expect(graphCell(merge, 2 * GAP, 18)).toEqual({ bits: U | L, lane: 'gemini' })
    expect(graphCell(merge, GAP, 18)).toEqual({ bits: U | D | R, lane: 'claude' })
    expect(steps.get('merge')?.path?.length).toBeGreaterThan(GAP)
  })

  test('adds gaps between heads and the appropriate step detail lines', () => {
    const running = layout(fold(demo, 18))
    expect(running.lines.slice(0, 2).map(l => l.kind)).toEqual(['head', 'step'])
    expect(running.lines.filter(l => l.kind === 'head' || l.kind === 'gap').map(l => l.kind)).toEqual(['head', 'gap', 'head', 'gap', 'head'])
    expect(running.lines[running.at.get('merge')!.line + 1]?.kind).toBe('live')
    for (const [t, detail] of [[22, ['prompt', 'count']], [31, ['prompt']]] as const) {
      const { lines, at } = layout(fold(demo, t))
      expect(lines.slice(at.get('gate')!.line + 1).map(l => l.kind)).toEqual(detail)
    }
  })

  test('focus follows the newest running step and gives the gate priority', () => {
    expect(focusAt(demo, fold(demo, 8), 8)).toEqual({ id: 'plang', since: 7.4 })
    const events: FlowEvent[] = [...demo.filter(e => e.t <= 22), { t: 22, id: 'build', lane: 'codex', state: 'running' }]
    expect(focusAt(events, fold(events, 22), 22)).toEqual({ id: 'gate', since: 21 })
  })
})

group('flow history', () => {
  test('lists flow starts in order and partitions legacy events', () => {
    const events = parseFlow(`{"t":1,"id":"legacy"}\n{"t":2,"kind":"flow","flow":"f1","title":"First","size":"small"}\n{"t":3,"flow":"f1","id":"x"}\n{"t":4,"kind":"flow","flow":"f2","title":"Second"}\n{"t":5,"kind":"flow","flow":"f1","state":"done"}\n{"t":6,"flow":"f2","id":"x"}`)
    expect(flows(events)).toEqual([{ id: 'f1', start: events[1] }, { id: 'f2', start: events[3] }])
    expect(currentFlow(events)).toBe('f2')
    expect(ofFlow(events, 'f1').map(e => e.t)).toEqual([2, 3, 5])
    expect(ofFlow(events, 'f2').map(e => e.t)).toEqual([4, 6])
    expect(ofFlow(events, null)).toEqual([])
    expect(currentFlow(events.slice(0, 1))).toBe(null)
    expect(ofFlow(events.slice(0, 1), null)).toEqual(events.slice(0, 1))
  })

  test('uses the latest pause or resume answer at or before the requested time', () => {
    const events: FlowEvent[] = [{ t: 2, answer: 'pause' }, { t: 3, answer: 'approve' }, { t: 4, answer: 'resume' },
      { t: 5, answer: 'pause' }, { t: 5, answer: 'resume' }]
    expect([1, 2, 3, 4, 5].map(t => paused(events, t))).toEqual([false, true, true, false, false])
  })
})
