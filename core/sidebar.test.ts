import { describe as group, expect, test } from 'claude-code/testing'

import type { FlowEvent } from './flow'
import { QUIET_AFTER, sidebarAlt, sidebarView, type FlowHead } from './sidebar'

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
  { t: 21, id: 'gate', lane: 'you', phase: 3, kind: 'gate', after: ['merge'], state: 'waiting', title: 'review the plan', summary: '16 points · 2 choices', wait: 30, until: 51 },
  { t: 40, id: 'gate', state: 'done', title: 'approved the plan' },
  { t: 40.4, id: 'buildx', lane: 'codex', phase: 4, after: ['gate'], state: 'running', title: 'building the event log', progress: 'core/flow.ts' },
  { t: 40.4, id: 'buildc', lane: 'claude', phase: 4, after: ['gate'], state: 'running', title: 'building the flow view' },
  { t: 41, id: 'buildx', meter: [3, 9, 'files'] },
]

group('the sidebar view', () => {
  test('a review waiting: the step now is Decide, the steps before are done, the review is yours', () => {
    const view = sidebarView(flow, head, false, 30)!
    expect(view.phase).toBe(3)
    expect(view.phases.map(p => p.state)).toEqual(['done', 'done', 'done', 'now', 'next', 'next', 'next'])
    expect(view.phases[1]!.lanes).toEqual(['gemini', 'claude'])
    expect(view.gate?.title).toBe('Review the plan')
    expect(view.working).toEqual([])
    expect(sidebarAlt(view)).toContain('step 4 of 7, Decide')
  })

  test('building: who works, with the meter as its detail', () => {
    const view = sidebarView(flow, head, false, 45)!
    expect(view.phase).toBe(4)
    expect(view.gate).toBe(null)
    expect(view.working.map(w => w.lane).sort()).toEqual(['claude', 'codex'])
    const codex = view.working.find(w => w.lane === 'codex')!
    expect(codex.detail).toBe('3/9 files')
    expect(codex.meter).toEqual([3, 9])
  })

  test('a finished flow shows every step done', () => {
    const done = sidebarView([...flow, { t: 60, kind: 'flow', flow: 'f1', state: 'done' }], { ...head, state: 'done' }, false, 61)!
    expect(done.finished).toBe(true)
    expect(done.phases.every(p => p.state === 'done')).toBe(true)
  })

  test('a flow left alone for half an hour is not shown, unless something still runs', () => {
    const quiet: FlowEvent[] = flow.slice(0, 9)
    expect(sidebarView(quiet, head, false, 20.5 + QUIET_AFTER + 1)).toBe(null)
    expect(sidebarView(flow, head, false, 41 + QUIET_AFTER + 1)).not.toBe(null)
    expect(sidebarView([], head, false, 1)).toBe(null)
    expect(sidebarView(flow, null, false, 30)).toBe(null)
  })
})
