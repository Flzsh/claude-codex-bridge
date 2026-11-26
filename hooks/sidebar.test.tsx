import { expect, test } from 'claude-code/testing'

import type { SidebarState } from '../types'
import { PANE_THEME } from '../core/pane'

const PANE = {
  plugin: 'codex-bridge',
  component: 'Pane',
  requestId: 'bridge',
  props: { title: 'Bridge', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const base: SidebarState = {
  look: 'cli',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="340" height="120"></svg>',
  alt: 'Workflow: ship it. step 4 of 7, Decide. waiting for you: Review the plan',
  height: 120,
  flow: 'f1',
  live: true,
  finished: false,
  paused: false,
  gate: null,
  claude: { busy: true, detail: 'editing main.ts' },
  notes: { waiting: 0, readAt: null },
  notice: null,
  sends: 0,
  opened: true,
}

/** Answers the pane's stored state as `value`, and nothing for every other key. */
const stored = (value: SidebarState) => (_: unknown, e: { key: string }) =>
  e.key === 'sidebar' ? { value: { value: { shape: 'sidebar-2', value }, version: 1 } } : { value: { value: undefined, version: 0 } }

test('with no workflow the pane says how to start one, on every surface', async ($, on) => {
  on('state.get', stored({ ...base, svg: '', flow: null, live: false, gate: null, claude: { busy: false, detail: '' }, alt: 'Claude is ready. No workflow.' }))
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /No workflow is running here/ }))?.text).toBe('No workflow is running here.')
    // started from the chat beside the pane
    expect((await ui.find({ type: 'Text', text: /^Start one in the chat/ }))?.text).toContain('say what it should do')
    expect(await ui.find({ type: 'Button', key: 'open-app' })).not.toBe(undefined)
    await ui.unmount()
  }
})

test('with no workflow and a picture: the picture shows how it goes, the terminal says it in words', async ($, on) => {
  on('state.get', stored({ ...base, flow: null, live: false, gate: null, claude: { busy: false, detail: '' }, alt: 'No workflow is running. Claude is ready.' }))
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Svg' })).not.toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /No workflow is running here/ })).toBe(undefined)
    expect(await ui.find({ type: 'Button', key: 'open-console' })).not.toBe(undefined)
    await ui.unmount()
  }
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /No workflow is running here/ }))?.text).toBe('No workflow is running here.')
  await terminal.unmount()
})

test('a review: the picture on surfaces that draw one, its words on the terminal, and the answers', async ($, on) => {
  on('state.get', stored({ ...base, gate: { id: 'g1', title: 'Review the plan', noAuto: false } }))
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const picture = await desktop.find({ type: 'Svg' })
  // in its interactive frame, where the desktop runs its motion (as an image it stands still),
  // its size given outright (else the frame is 150 px tall and the drawing shrinks into it)
  expect(picture?.props.isInteractive).toBe(true)
  expect([picture?.props.width, picture?.props.height]).toEqual([340, 120])
  expect(await desktop.find({ type: 'Button', key: 'gate-approve' })).not.toBe(undefined)
  expect(await desktop.find({ type: 'Button', key: 'gate-pause' })).not.toBe(undefined)
  expect(await desktop.find({ type: 'Button', key: 'gate-decline' })).not.toBe(undefined)
  // a change to the review is asked for in the chat
  expect((await desktop.find({ type: 'Text', text: /Ask for changes in the chat/ }))?.text).toContain('carries on when the time runs out')
  // drawn as coloured words in the look, not the app's grey buttons
  expect((await desktop.find({ type: 'Button', key: 'gate-approve' }))?.props.plain).toBe(true)
  // the picture says whose turn it is; the edge of the pane turns amber
  expect(await desktop.find({ type: 'Text', text: /^Your turn/ })).toBe(undefined)
  expect((await desktop.find({ type: 'Box' }))?.props.borderColor).toBe(PANE_THEME.cli.waitingEdge)
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ type: 'Svg' })).toBe(undefined)
  expect((await terminal.find({ type: 'Text', text: /^Workflow: ship it/ }))?.text).toContain('Review the plan')
  await terminal.unmount()
})

test('a review that needs a real yes offers Yes and Not now, and no pause', async ($, on) => {
  on('state.get', stored({ ...base, gate: { id: 'g2', title: 'Push to GitHub', noAuto: true } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'gate-approve' }))?.props.label).toBe('Yes')
  expect((await ui.find({ type: 'Button', key: 'gate-decline' }))?.props.label).toBe('Not now')
  expect(await ui.find({ type: 'Button', key: 'gate-pause' })).toBe(undefined)
  await ui.unmount()
})

test('no text boxes: what you would type is said in the chat beside the pane', async ($, on) => {
  let state: SidebarState = base
  on('state.get', (_: unknown, e: { key: string }) => stored(state)(_, e))
  const states: SidebarState[] = [
    { ...base, svg: '', flow: null, live: false, gate: null },
    { ...base, flow: null, live: false, gate: null },
    base,
    { ...base, gate: { id: 'g1', title: 'Review the plan', noAuto: false } },
  ]
  for (const next of states) {
    state = next
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.findAll({ type: 'Input' })).toEqual([])
      await ui.unmount()
    }
  }
})

for (const look of ['cli', 'drawn'] as const) {
  test(`${look}: where the picture draws, the whole pane is one card in the look, filling the pane`, async ($, on) => {
    on('state.get', stored({ ...base, look, flow: null, live: false, gate: null }))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const card = await ui.find({ type: 'Box' })
    expect([card?.props.backgroundColor, card?.props.borderColor, card?.props.borderStyle]).toEqual([PANE_THEME[look].ground, PANE_THEME[look].edge, 'round'])
    // as tall as the rows the pane shows
    expect(card?.props.minHeight).toBe(40)
    // its buttons are drawn as coloured words in the look
    expect((await ui.find({ type: 'Button', key: 'open-app' }))?.props.plain).toBe(true)
    expect((await ui.find({ type: 'Button', key: 'open-console' }))?.props.plain).toBe(true)
    await ui.unmount()
  })
}

test('mid-workflow: steering is said in the chat; a note left from the app still shows', async ($, on) => {
  on('state.get', stored({ ...base, notes: { waiting: 1, readAt: null } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Running/ }))?.text).toBe('Running. To steer it, tell Claude in the chat.')
  expect(await ui.find({ type: 'Button', key: 'flow-pause' })).not.toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /waits for Claude/ }))?.text).toBe("◐ Your note waits for Claude's next step")
  expect((await ui.find({ type: 'Text', text: /^Claude now/ }))?.text).toBe('Claude now: editing main.ts')
  await ui.unmount()
})
