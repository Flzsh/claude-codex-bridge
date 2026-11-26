import type { Lane, Size, Stage } from './console'

export type StepKind = 'ask' | 'plan' | 'merge' | 'decide' | 'build' | 'review' | 'ship'
export type Step = {
  kind: StepKind
  label: string
  who: Lane[]
  codex?: 'one' | 'all'
  rounds?: 1 | 2
  gate?: 'none' | 'timed' | 'yes'
}
export type Workflow = { v: 1; sizes: Record<Size, Step[]> }

export const DEFAULT_WORKFLOW: Workflow = {
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

const LANES: readonly Lane[] = ['you', 'claude', 'gemini', 'codex']
const LABELS: Record<StepKind, string> = {
  ask: 'Ask', plan: 'Plan', merge: 'Merge', decide: 'Decide', build: 'Build', review: 'Review', ship: 'Check & ship',
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function normalizeStep(value: unknown, defaults: Step[]): Step | undefined {
  const raw = record(value)
  const kind = raw?.kind as StepKind
  if (!raw || typeof kind !== 'string' || !Object.hasOwn(LABELS, kind)) return
  const cleanLabel = typeof raw.label === 'string' ? raw.label.replace(/[\r\n\u2028\u2029]+/g, ' ').trim() : ''
  const label = Array.from(cleanLabel).slice(0, 24).join('').trimEnd() ||
    defaults.find(step => step.kind === kind)?.label || LABELS[kind]
  const rawWho = Array.isArray(raw.who) ? raw.who : []
  let who = [...new Set(rawWho.filter((lane): lane is Lane => LANES.includes(lane)))]
  const step: Step = { kind, label, who }
  if (raw.gate === 'timed' || raw.gate === 'yes' || raw.gate === 'none') step.gate = raw.gate

  switch (kind) {
    case 'ask':
    case 'decide':
      who = ['you']
      if (kind === 'decide' && step.gate !== 'yes') step.gate = 'timed'
      break
    case 'ship':
      who = ['claude', 'you']
      break
    case 'plan':
    case 'merge':
      if (!who.includes('claude')) who.push('claude')
      break
    case 'build':
      who = who.filter(lane => lane === 'claude' || lane === 'codex')
      if (who.includes('codex')) step.codex = raw.codex === 'all' ? 'all' : 'one'
      break
    case 'review':
      who = who.filter(lane => lane !== 'you')
      step.rounds = raw.rounds === 2 ? 2 : 1
      break
  }
  step.who = who.length ? who : ['claude']
  return step
}

function normalizeSize(sizes: Record<string, unknown> | undefined, size: Size): Step[] {
  const defaults = DEFAULT_WORKFLOW.sizes[size].map(step => ({ ...step, who: [...step.who] }))
  try {
    const raw = sizes?.[size]
    if (!Array.isArray(raw)) return defaults
    const steps = raw.map(value => normalizeStep(value, defaults)).filter((step): step is Step => step !== undefined)
    if (!steps.length) return defaults
    const first = steps.findIndex(step => step.kind === 'ask')
    const last = steps.findLastIndex(step => step.kind === 'ship')
    const work = steps.filter((step, i) => i !== first && i !== last && step.kind !== 'ask' && step.kind !== 'ship')
    return [steps[first] ?? defaults[0]!, ...work.slice(0, 7), steps[last] ?? defaults.at(-1)!]
  } catch {
    return defaults
  }
}

export function normalizeWorkflow(value: unknown): Workflow {
  let sizes: Record<string, unknown> | undefined
  try {
    const raw = record(value)
    if (raw?.v === 1) sizes = record(raw.sizes)
  } catch {
    // Unreadable settings use the defaults.
  }
  return {
    v: 1,
    sizes: {
      small: normalizeSize(sizes, 'small'),
      medium: normalizeSize(sizes, 'medium'),
      large: normalizeSize(sizes, 'large'),
    },
  }
}

export function parseWorkflow(text: string | null): Workflow {
  try {
    return normalizeWorkflow(text === null ? null : JSON.parse(text))
  } catch {
    return normalizeWorkflow(null)
  }
}

function names(lanes: readonly Lane[]): string {
  return lanes.map(lane => lane[0]!.toUpperCase() + lane.slice(1)).join(', ')
}

export function stagesOf(workflow: Workflow, size: Size): Stage[] {
  return workflow.sizes[size].map(({ kind, label, who }) => ({ id: kind, label, lanes: who, who: names(who) }))
}

export function describeSteps(workflow: Workflow, size: Size): string {
  return workflow.sizes[size].map((step, phase) => {
    const details: string[] = []
    if (step.kind === 'build' && step.who.includes('codex')) {
      const ui = step.who.includes('claude') ? ', claude the UI' : ''
      details.push(step.codex === 'all' ? `codex builds every backend block${ui}` : 'codex builds one bounded block')
    }
    if (step.kind === 'review') details.push(step.rounds === 2 ? '2 review rounds' : '1 review round')
    const gate = step.gate ?? (step.kind === 'decide' ? 'timed' : 'none')
    if (gate === 'timed') details.push('you review after it: carries on after the wait')
    if (gate === 'yes') details.push('you review after it: needs your yes')
    return `${phase} ${step.kind} | ${step.label} | ${names(step.who)} | ${details.join('; ') || '-'}`
  }).join('\n')
}
