import { describe as group, expect, test } from 'claude-code/testing'

import { SIZES, STAGES, stagesFor } from './console'
import { DEFAULT_WORKFLOW, describeSteps, normalizeWorkflow, parseWorkflow, stagesOf } from './workflow'

// The plugin runner cannot import JSON. flow.test.sh checks the shipped file.
const shippedWorkflow = {
  v: 1,
  sizes: {
    small: [
      { kind: 'ask', label: 'Ask', who: ['you'] },
      { kind: 'build', label: 'Do', who: ['claude'] },
      { kind: 'ship', label: 'Check', who: ['claude', 'you'] },
    ],
    medium: [
      { kind: 'ask', label: 'Ask', who: ['you'] },
      { kind: 'plan', label: 'Plan', who: ['claude'] },
      { kind: 'build', label: 'Build', who: ['claude', 'codex'], codex: 'one' },
      { kind: 'review', label: 'Review', who: ['codex', 'gemini'], rounds: 1 },
      { kind: 'ship', label: 'Check & ship', who: ['claude', 'you'] },
    ],
    large: [
      { kind: 'ask', label: 'Ask', who: ['you'] },
      { kind: 'plan', label: 'Two plans', who: ['claude', 'gemini'] },
      { kind: 'merge', label: 'Merge', who: ['claude'] },
      { kind: 'decide', label: 'Decide', who: ['you'], gate: 'timed' },
      { kind: 'build', label: 'Build', who: ['claude', 'codex'], codex: 'all' },
      { kind: 'review', label: 'Review', who: ['gemini', 'codex'], rounds: 2 },
      { kind: 'ship', label: 'Check & ship', who: ['claude', 'you'] },
    ],
  },
}

group('workflow settings', () => {
  test('the app uses the shipped workflow defaults', () => {
    expect(shippedWorkflow).toEqual(DEFAULT_WORKFLOW)
    expect(parseWorkflow(JSON.stringify(shippedWorkflow))).toEqual(DEFAULT_WORKFLOW)
    for (const size of SIZES) expect(stagesFor(size)).toEqual(stagesOf(DEFAULT_WORKFLOW, size))
    expect(stagesFor('large')).toEqual(STAGES)
  })

  test('repairs steps and keeps their order between the restored ends', () => {
    const workflow = normalizeWorkflow({ v: 1, sizes: { medium: [
      { kind: 'plan', label: 'Plan', who: ['gemini', 'gemini'], rounds: 2 },
      { kind: 'build', label: 'Build', who: ['gemini', 'codex'], extra: true },
      { kind: 'decide', label: 'Decide', who: ['claude'], gate: 'none', codex: 'all' },
      { kind: 'review', label: 'Review', who: ['you', 'gemini'], rounds: 3 },
    ] } })
    expect(workflow.sizes.medium).toEqual([
      { kind: 'ask', label: 'Ask', who: ['you'] },
      { kind: 'plan', label: 'Plan', who: ['gemini', 'claude'] },
      { kind: 'build', label: 'Build', who: ['codex'], codex: 'one' },
      { kind: 'decide', label: 'Decide', who: ['you'], gate: 'timed' },
      { kind: 'review', label: 'Review', who: ['gemini'], rounds: 1 },
      { kind: 'ship', label: 'Check & ship', who: ['claude', 'you'] },
    ])
    expect(workflow.sizes.small).toEqual(DEFAULT_WORKFLOW.sizes.small)
  })

  test('keeps the first seven working steps and the custom bookends when cutting ten steps to nine', () => {
    const workflow = normalizeWorkflow({ v: 1, sizes: { small: [
      { kind: 'ask', label: 'Request', who: ['gemini'] },
      ...Array.from({ length: 8 }, (_, i) => ({ kind: 'build', label: `Build ${i}`, who: ['gemini'] })),
      { kind: 'ship', label: 'Deliver', who: ['codex'] },
    ] } })
    expect(workflow.sizes.small.map(step => step.label)).toEqual([
      'Request', 'Build 0', 'Build 1', 'Build 2', 'Build 3', 'Build 4', 'Build 5', 'Build 6', 'Deliver',
    ])
    expect(workflow.sizes.small[0]!.who).toEqual(['you'])
    expect(workflow.sizes.small[1]!.who).toEqual(['claude'])
    expect(workflow.sizes.small[8]!.who).toEqual(['claude', 'you'])
  })

  test('moves misplaced bookends, drops extra ones, and keeps added steps in their chosen order', () => {
    const workflow = normalizeWorkflow({ v: 1, sizes: { small: [
      { kind: 'ship', label: 'Deliver' },
      { kind: 'review', label: 'First pass', who: ['codex'] },
      { kind: 'ask', label: 'Request' },
      { kind: 'ask', label: 'Ask again' },
      { kind: 'review', label: 'Second pass', who: ['gemini'] },
    ] } })
    expect(workflow.sizes.small.map(step => step.label)).toEqual([
      // an ask or a ship in the middle belongs only at the ends: dropped, not left stuck
      'Request', 'First pass', 'Second pass', 'Deliver',
    ])
  })

  test('falls back for bad JSON, missing settings and unusable sizes', () => {
    expect(parseWorkflow('{')).toEqual(DEFAULT_WORKFLOW)
    expect(parseWorkflow(null)).toEqual(DEFAULT_WORKFLOW)
    expect(normalizeWorkflow({ v: 2, sizes: DEFAULT_WORKFLOW.sizes })).toEqual(DEFAULT_WORKFLOW)
    expect(normalizeWorkflow({ v: 1, sizes: { small: [null, { kind: 'unknown' }] } })).toEqual(DEFAULT_WORKFLOW)
    expect(normalizeWorkflow({ get v() { throw new Error('unreadable') } })).toEqual(DEFAULT_WORKFLOW)
  })

  test('projects custom steps to stages and prints the same lines as flow.sh', () => {
    const workflow = normalizeWorkflow({ v: 1, sizes: { medium: [
      { kind: 'plan', label: 'Plan', who: ['claude'] },
      { kind: 'build', label: 'Build backend', who: ['codex'], codex: 'all', gate: 'yes' },
      { kind: 'review', label: 'Gemini review', who: ['gemini'], rounds: 2 },
    ] } })
    const build = { id: 'build', label: 'Build backend', lanes: ['codex'], who: 'Codex' }
    expect(stagesOf(workflow, 'medium')[2]).toEqual(build)
    expect(stagesFor('medium', workflow)[2]).toEqual(build)
    expect(describeSteps(workflow, 'medium')).toBe([
      '0 ask | Ask | You | -',
      '1 plan | Plan | Claude | -',
      '2 build | Build backend | Codex | codex builds every backend block; you review after it: needs your yes',
      '3 review | Gemini review | Gemini | 2 review rounds',
      '4 ship | Check & ship | Claude, You | -',
    ].join('\n'))
    expect(describeSteps(DEFAULT_WORKFLOW, 'large').split('\n').slice(3, 6)).toEqual([
      '3 decide | Decide | You | you review after it: carries on after the wait',
      '4 build | Build | Claude, Codex | codex builds every backend block, claude the UI',
      '5 review | Review | Gemini, Codex | 2 review rounds',
    ])
  })
})
