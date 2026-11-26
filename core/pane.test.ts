import { describe as group, expect, test } from 'claude-code/testing'

import type { FlowEvent, Lane } from './flow'
import { ago, emptyAlt, emptyLayoutWidth, emptySvg, lastFlow, onWhite, paneAlt, paneModel, paneSvg, pictureWidth, type EmptyModel, type PaneRow } from './pane'
import type { FlowHead } from './sidebar'

const head: FlowHead = { id: 'f1', title: 'turn Bridge into the command center', size: 'large', state: null }
const flow: FlowEvent[] = [
  { t: 3.3, id: 'ask', lane: 'you', phase: 0, state: 'done', title: 'asked' },
  { t: 3.8, id: 'size', lane: 'claude', phase: 0, after: ['ask'], state: 'running', title: 'sizing the work' },
  { t: 7, id: 'size', state: 'done', title: 'sized the work' },
  { t: 7.4, id: 'plang', lane: 'gemini', phase: 1, after: ['size'], state: 'running', title: 'writing its own plan' },
  { t: 7.4, id: 'planc', lane: 'claude', phase: 1, after: ['size'], state: 'running', title: 'writing a plan' },
  { t: 15.5, id: 'planc', state: 'done', title: 'wrote a plan' },
  { t: 17, id: 'plang', state: 'done', title: 'wrote its own plan' },
  { t: 17.4, id: 'merge', lane: 'claude', phase: 2, after: ['planc', 'plang'], state: 'running', title: 'merging the plans' },
  { t: 20.5, id: 'merge', state: 'done', title: 'merged the plans' },
  { t: 20.8, id: 'gate', log: ['h', 'Plan'] },
  { t: 20.8, id: 'gate', log: ['#', 'one event log|C G'] },
  { t: 20.8, id: 'gate', log: ['?', 'A|steer to claude first, or straight to the agent?'] },
  { t: 21, id: 'gate', lane: 'you', phase: 3, kind: 'gate', after: ['merge'], state: 'waiting', title: 'review the plan', summary: '16 points · 2 choices', wait: 30, until: 51 },
  { t: 40, id: 'gate', state: 'done', title: 'approved the plan' },
  { t: 40.4, id: 'buildx', lane: 'codex', phase: 4, after: ['gate'], state: 'running', title: 'building the event log', progress: 'core/flow.ts' },
  { t: 40.4, id: 'buildc', lane: 'claude', phase: 4, after: ['gate'], state: 'running', title: 'building the flow view' },
  { t: 41, id: 'buildx', meter: [3, 9, 'files'] },
  { t: 41.5, id: 'buildx', log: ['●', 'Write core/flow.ts'] },
]

const steps = (rows: PaneRow[]) => rows.flatMap(r => (r.kind === 'step' ? [r] : []))

group('the pane model', () => {
  test('the whole workflow: every step in order, in its lane, with the lines between them', () => {
    const m = paneModel(flow, head, false, 45)!
    // at a tie, the step whose line reaches furthest comes first (as the app lays it out)
    expect(steps(m.rows).map(r => r.id)).toEqual(['ask', 'size', 'plang', 'planc', 'merge', 'gate', 'buildx', 'buildc'])
    expect(steps(m.rows).find(r => r.id === 'plang')!.lane).toBe('gemini')
    expect(m.rows.some(r => r.kind === 'conn' && r.cells.length > 0)).toBe(true)
    expect(m.rows.filter(r => r.kind === 'head').map(r => (r.kind === 'head' ? r.label : ''))).toEqual(['ask', 'two plans', 'merge', 'decide', 'build'])
  })

  test('done steps say how long they took; a working one its count', () => {
    const rows = steps(paneModel(flow, head, false, 45)!.rows)
    expect(rows.find(r => r.id === 'size')!.right).toBe('3s')
    expect(rows.find(r => r.id === 'buildx')!.right).toBe('3/9 files')
    expect(rows.find(r => r.id === 'gate')!.right).toBe('approved')
  })

  test('a review in focus brings its points and choices, who proposed each, and its time', () => {
    const m = paneModel(flow, head, false, 30)!
    expect(m.detail?.id).toBe('gate')
    expect(m.detail?.gate).toEqual({ noAuto: false, wait: 30, until: 51 })
    expect(m.detail?.lines).toEqual([
      { mark: 'h', text: 'Plan' },
      { mark: '#', text: 'one event log', who: 'C G' },
      { mark: '?', text: 'A  steer to claude first, or straight to the agent?' },
    ])
    expect(paneAlt(m)).toContain('waiting for you: review the plan')
  })

  test('mid-build the newest working step is in focus, with its count and last action', () => {
    const d = paneModel(flow, head, false, 45)!.detail!
    expect(d.lane).toBe('codex')
    expect(d.meter).toEqual([3, 9, 'files'])
    expect(d.words).toBe('core/flow.ts')
    expect(d.lines).toEqual([{ mark: '●', text: 'Write core/flow.ts' }])
  })

  test('a finished flow has no focus and carries its summary', () => {
    const m = paneModel([...flow, { t: 60, kind: 'flow', flow: 'f1', state: 'done', summary: 'shipped' }], { ...head, state: 'done' }, false, 61)!
    expect(m.finished).toBe(true)
    expect(m.detail).toBe(null)
    expect(m.summary).toBe('shipped')
    expect(paneAlt(m)).toContain('finished: shipped')
  })

  test('nothing to show: no flow, or one left alone for long', () => {
    expect(paneModel([], head, false, 1)).toBe(null)
    expect(paneModel(flow, null, false, 30)).toBe(null)
  })
})

/** A long flow: many steps across all four lanes, four working, and a review with many points. */
function bigFlow(count: number): FlowEvent[] {
  const out: FlowEvent[] = [{ t: 0, id: 'ask', lane: 'you', phase: 0, state: 'done', title: 'asked' }]
  const lanes: Lane[] = ['claude', 'gemini', 'codex', 'claude']
  for (let i = 1; i <= count; i++) {
    const lane = lanes[i % 4]!
    out.push({ t: i, id: `s${i}`, lane, phase: Math.min(5, Math.floor(i / 8)), after: [i === 1 ? 'ask' : `s${i - 1}`], state: 'running', title: `step number ${i} with a fairly long title <&>` })
    if (i < count - 3) out.push({ t: i + 0.5, id: `s${i}`, state: 'done', title: `did step ${i}` })
  }
  for (let k = 0; k < 24; k++) out.push({ t: count + 1, id: 'g', log: ['#', `point ${k} of the review, said at some length so it wraps|C G X`] })
  out.push({ t: count + 1, id: 'g', log: ['?', 'A|one or the other?'] })
  out.push({ t: count + 2, id: 'g', lane: 'you', phase: 6, kind: 'gate', after: [`s${count}`], state: 'waiting', title: 'review it all', wait: 120, until: count + 122 })
  return out
}

group('the pane picture', () => {
  for (const look of ['cli', 'drawn'] as const) {
    test(`${look}: a whole picture at each moment, wide enough for the pane`, () => {
      for (const at of [5, 30, 45]) {
        const svg = paneSvg(paneModel(flow, head, false, at)!, look, at)
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="460"')).toBe(true)
        expect(svg.endsWith('</svg>')).toBe(true)
        expect(svg.includes('NaN') || svg.includes('undefined')).toBe(false)
      }
    })

    test(`${look}: the review counts down from the seconds left when the picture is made`, () => {
      const svg = paneSvg(paneModel(flow, head, false, 30)!, look, 30)
      // 21 s left: "21s" shows at once, "20s" from 1 s in, and the drain runs 21 s
      expect(svg).toContain('visibility="visible">21s')
      expect(svg).toContain('>20s<set attributeName="visibility" to="visible" begin="1.00s"')
      expect(svg).toContain('dur="21.00s" fill="freeze"')
      expect(svg).toContain('one event log')
    })

    test(`${look}: a paused review shows paused, with no countdown`, () => {
      const svg = paneSvg(paneModel(flow, head, true, 30)!, look, 30)
      expect(svg).toContain('>paused<')
      expect(svg.includes('21s')).toBe(false)
    })

    test(`${look}: a long flow with a long review stays inside the element's limit`, () => {
      for (const count of [40, 400]) {
        const events = bigFlow(count)
        const m = paneModel(events, head, false, count + 5)!
        const svg = paneSvg(m, look, count + 5)
        expect(svg.length).toBeLessThan(131072)
        expect(svg).toContain('earlier step')
        // the review keeps its choice, and says how much more there is
        expect(svg).toContain('one or the other?')
        expect(svg).toContain('more in the app')
        expect(svg.includes('NaN') || svg.includes('undefined')).toBe(false)
      }
    })
  }

  test('laid out for the pane: its width from the cells across, in steps, within bounds, never wider than the pane', () => {
    expect(pictureWidth(0)).toBe(460)
    expect(pictureWidth(32)).toBe(220)
    expect(pictureWidth(61)).toBe(420)
    expect(pictureWidth(10)).toBe(200)
    expect(pictureWidth(200)).toBe(620)
    // no wider than the pane (at 7 px or more a cell), or its frame is narrowed and the drawing shrinks in it
    for (const columns of [40, 55, 61, 70, 80]) expect(pictureWidth(columns)).toBeLessThanOrEqual(columns * 7)
  })

  for (const look of ['cli', 'drawn'] as const) {
    test(`${look}: a narrow pane keeps the title and every lane's name`, () => {
      const svg = paneSvg(paneModel(flow, head, false, 45)!, look, 45, 260)
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="260"')).toBe(true)
      // the size and step count give way to the title
      expect(svg.includes('large ·')).toBe(false)
      expect(paneSvg(paneModel(flow, head, false, 45)!, look, 45, 460)).toContain('large ·')
      for (const name of look === 'cli' ? ['you', 'claude', 'gemini', 'codex'] : ['You', 'Claude', 'Gemini', 'Codex']) expect(svg).toContain(`>${name}</text>`)
      // every name inside the picture
      for (const [, x] of svg.matchAll(/<text x="([\d.]+)"[^>]*>(?:you|claude|gemini|codex|You|Claude|Gemini|Codex)<\/text>/g)) expect(Number(x)).toBeLessThan(260 - 40)
    })
  }

  for (const look of ['cli', 'drawn'] as const) {
    test(`${look}: a pulse runs down the line into each working step, as in the app, and none when paused`, () => {
      // mid-build two steps work: a line runs into each
      const m = paneModel(flow, head, false, 45)!
      expect(m.flows.map(one => one.lane).sort()).toEqual(['claude', 'codex'])
      expect(m.flows.every(one => one.cells.length > 1)).toBe(true)
      const svg = paneSvg(m, look, 45)
      const liquid = /<g class="pulse">/g
      expect((svg.match(liquid) ?? []).length).toBe(2)
      // paused, nothing runs; before the build, no step works and no line runs
      expect((paneSvg(paneModel(flow, head, true, 45)!, look, 45).match(liquid) ?? []).length).toBe(0)
      expect(paneModel(flow, head, false, 2)?.flows ?? []).toEqual([])
    })
  }

  test('between steps, Claude at work shows as a working row at the end; not when a step works or it is paused', () => {
    const working = (m: ReturnType<typeof paneModel>) => (m?.rows ?? []).filter(r => r.kind === 'step' && r.id === '~claude').length
    // at 21 s the plans are merged and nothing runs yet
    const between = flow.filter(e => e.t <= 20.6)
    expect(working(paneModel(between, head, false, 20.6, true))).toBe(1)
    expect(working(paneModel(between, head, false, 20.6, false))).toBe(0)
    expect(working(paneModel(between, head, true, 20.6, true))).toBe(0)
    // mid-build two steps work: no extra row
    expect(working(paneModel(flow, head, false, 45, true))).toBe(0)
    // a review waits for you: Claude waits too, no working row
    expect(working(paneModel(flow, head, false, 30, true))).toBe(0)
    expect(paneSvg(paneModel(between, head, false, 20.6, true)!, 'cli', 20.6)).toContain('working on the next step')
  })

  test('a working step right below the one it follows still gets its pulse, from that node', () => {
    const events: FlowEvent[] = [
      { t: 1, id: 'ask', lane: 'you', phase: 0, state: 'done', title: 'asked' },
      { t: 2, id: 'a', lane: 'claude', phase: 1, after: ['ask'], state: 'done', title: 'did a' },
      { t: 3, id: 'b', lane: 'claude', phase: 1, after: ['a'], state: 'running', title: 'doing b' },
    ]
    const m = paneModel(events, head, false, 4)!
    expect(m.flows.length).toBe(1)
    const cells = m.flows[0]!.cells
    expect(cells.length).toBeGreaterThan(1)
    // it starts at a's node and ends at b's
    const rowOf = (id: string) => m.rows.findIndex(r => r.kind === 'step' && r.id === id)
    expect(cells[0]![0]).toBe(rowOf('a'))
    expect(cells[cells.length - 1]![0]).toBe(rowOf('b'))
  })

  test('text is escaped', () => {
    const svg = paneSvg(paneModel(flow, { ...head, title: 'a <b> & "c"' }, false, 45)!, 'cli', 45)
    expect(svg).toContain('a &lt;b&gt; &amp; &quot;c&quot;')
    expect(paneSvg(paneModel(bigFlow(40), head, false, 45)!, 'drawn', 45)).toContain('&lt;&amp;&gt;')
  })
})

group('the pane with no workflow', () => {
  const ended: FlowEvent[] = [
    { t: 1, flow: 'f1', kind: 'flow', title: 'ship <it>', size: 'medium' },
    ...flow.map(e => ({ ...e, flow: 'f1' })),
    { t: 60, flow: 'f1', kind: 'flow', state: 'done', summary: 'shipped & checked' },
  ]

  test('it recalls the last workflow: its steps by who did them, how it ended and when', () => {
    const last = lastFlow(ended, 'f1', 60 + 2 * 3600)!
    expect(last.title).toBe('ship <it>')
    expect(last.finished).toBe(true)
    expect(last.summary).toBe('shipped & checked')
    expect(last.lanes[0]).toBe('you')
    // eight in all: seven steps and one review
    expect(last.steps).toBe(7)
    expect(last.reviews).toBe(1)
    expect(last.ago).toBe('2h ago')
    expect(lastFlow(ended, null, 0)).toBe(null)
    expect(lastFlow([], 'f1', 0)).toBe(null)
  })

  test('ages read as people say them', () => {
    expect([ago(5), ago(600), ago(3 * 3600), ago(3 * 86400)]).toEqual(['just now', '10 min ago', '3h ago', '3d ago'])
  })

  for (const look of ['cli', 'drawn'] as const) {
    test(`${look}: the shape of a workflow, then the last one and the last runs, escaped`, () => {
      const m: EmptyModel = {
        busy: false,
        last: lastFlow(ended, 'f1', 120),
        runs: [{ provider: 'codex', title: 'review <this>', state: 'done', ago: '1 min ago' }],
      }
      const svg = emptySvg(m, look)
      // laid out 400 wide and drawn 460 wide: larger, at the pane's width
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="460"')).toBe(true)
      const [, h, vh] = /^<svg[^>]* height="(\d+)" viewBox="0 0 400 (\d+)"/.exec(svg)!
      expect(Math.abs(Number(h) - Number(vh) * 1.15)).toBeLessThan(1)
      expect(svg).toContain('you say what it should do')
      expect(svg).toContain('ship &lt;it&gt;')
      expect(svg).toContain('review &lt;this&gt;')
      expect(svg).toContain('ready')
      expect(svg.includes('NaN') || svg.includes('undefined')).toBe(false)
      // a first run has neither part, and a working Claude says so
      const first = emptySvg({ busy: true, last: null, runs: [] }, look)
      expect(first).toContain('working')
      expect(first.includes('Last workflow') || first.includes('last workflow')).toBe(false)
      expect(first.includes('Recent runs') || first.includes('recent runs')).toBe(false)
    })
  }

  test('in a narrow pane it is laid out at the width it is drawn, its type kept', () => {
    const svg = emptySvg({ busy: true, last: lastFlow(ended, 'f1', 120), runs: [] }, 'cli', 260)
    expect(/^<svg[^>]* width="260" height="(\d+)" viewBox="0 0 260 \1"/.test(svg)).toBe(true)
    // in the head, "claude" gives way to "no workflow yet"; the state stays
    const head = (s: string) => [...s.matchAll(/<text [^>]*y="25"[^>]*>([^<]*)<\/text>/g)].map(m => m[1])
    expect(head(svg)).toContain('working')
    expect(head(svg)).not.toContain('claude')
    expect(head(emptySvg({ busy: true, last: null, runs: [] }, 'cli', 460))).toContain('claude')
    expect(emptyLayoutWidth(460)).toBe(400)
    expect(emptyLayoutWidth(360)).toBe(313)
  })

  test('its words for the terminal', () => {
    expect(emptyAlt({ busy: true, last: null, runs: [] })).toBe('No workflow is running. Claude is working.')
    expect(emptyAlt({ busy: false, last: lastFlow(ended, 'f1', 120), runs: [] })).toContain('Last workflow: ship <it>, finished 1 min ago.')
  })
})

group('on white', () => {
  const lightness = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
    return (Math.max(r, g, b) + Math.min(r, g, b)) / 2
  }
  const colours = (svg: string) => [...new Set(svg.match(/#[0-9a-f]{6}/gi) ?? [])].map(c => c.toLowerCase())

  test('the terminal ground turns white, and every other colour its lightness turned over', () => {
    const dark = emptySvg({ busy: true, last: null, runs: [] }, 'cli', 440, 'bare')
    const white = onWhite(dark)
    expect(colours(white)).not.toContain('#151413')
    // light words turn dark, dark lines turn light; hues are kept
    expect(onWhite('#151413')).toBe('#ffffff')
    expect(lightness(onWhite('#ece9e2'))).toBeLessThan(0.2)
    expect(lightness(onWhite('#2a2826'))).toBeGreaterThan(0.8)
    const orange = onWhite('#d97757')
    expect(parseInt(orange.slice(1, 3), 16)).toBeGreaterThan(parseInt(orange.slice(5, 7), 16))
    // the drawing is the same apart from its colours
    expect(white.replace(/#[0-9a-f]{6}/gi, '#')).toBe(dark.replace(/#[0-9a-f]{6}/gi, '#'))
  })
})
