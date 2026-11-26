import type { ConsoleMode, ConsoleState, ConsoleTab, Entry, LogItem, Provider } from '../types'
import { DEFAULT_WORKFLOW, stagesOf, type Workflow } from './workflow'

export type { ConsoleMode, ConsoleState, ConsoleTab, Entry, LogItem }

/** Codex models offered in the console, best value first (see the skill's model reference). */
export const CODEX_MODELS = ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol'] as const

export const NEW_CONSOLE: ConsoleState = {
  tab: 'chat',
  provider: 'codex',
  codexModel: CODEX_MODELS[0],
  mode: 'read-only',
  sessions: { codex: null, gemini: null },
  entries: [],
  runningSince: null,
  sends: 0,
  project: null,
  decisions: [],
  log: [],
}

/** Entries kept in the transcript; older ones drop off. */
export const KEEP_ENTRIES = 80

export type Command =
  | { kind: 'prompt'; text: string }
  | { kind: 'new' }
  | { kind: 'stop' }
  | { kind: 'clear' }
  | { kind: 'help' }
  | { kind: 'provider'; provider: Provider }
  | { kind: 'model'; model: string }
  | { kind: 'effort'; level: string | null }
  | { kind: 'mode'; mode: ConsoleMode }
  | { kind: 'project'; goal: string | null }
  | { kind: 'note'; text: string }
  | { kind: 'claude'; text: string }
  | { kind: 'stage'; id: string }
  | { kind: 'size'; size: Size }
  | { kind: 'unknown'; text: string }

export const HELP = [
  '/codex, /gemini   switch who answers',
  '/new              start a fresh conversation',
  '/model <name>     Codex model, e.g. /model gpt-6.2-astra',
  '/effort <level>   low … ultra, or /effort default',
  '/mode read | write   what Codex may do in this folder',
  '/stop             stop the running prompt',
  '/project          show the shared project (.bridge/)',
  '/project start <goal>   start one in this folder',
  '/note <text>      add a note to the shared log',
  '/claude [text]    ask Claude; alone, puts the last reply in your prompt box',
  '/stage <step>     move the flow: ask, plan, merge, decide, build, review, ship, or next',
  '/size <size>      how much workflow: small, medium or large',
  '/clear            clear this transcript',
].join('\n')

/** What a line typed into the console asks for. */
export function parseCommand(input: string): Command {
  const text = input.trim()
  if (!text.startsWith('/')) return { kind: 'prompt', text }
  const [word = '', ...rest] = text.slice(1).split(/\s+/)
  const arg = rest.join(' ').trim()
  switch (word.toLowerCase()) {
    case 'new':
      return { kind: 'new' }
    case 'stop':
      return { kind: 'stop' }
    case 'clear':
      return { kind: 'clear' }
    case 'help':
      return { kind: 'help' }
    case 'codex':
      return { kind: 'provider', provider: 'codex' }
    case 'gemini':
      return { kind: 'provider', provider: 'gemini' }
    case 'project': {
      if (!arg) return { kind: 'project', goal: null }
      const goal = /^start\s+(.+)$/i.exec(arg)?.[1]?.trim()
      return goal ? { kind: 'project', goal } : { kind: 'unknown', text }
    }
    case 'note':
      return arg ? { kind: 'note', text: arg } : { kind: 'unknown', text }
    case 'claude':
      return { kind: 'claude', text: arg }
    case 'stage': {
      const id = arg.toLowerCase()
      return id === 'next' || STAGES.some(stage => stage.id === id) ? { kind: 'stage', id } : { kind: 'unknown', text }
    }
    case 'size': {
      const size = arg.toLowerCase()
      return (SIZES as readonly string[]).includes(size) ? { kind: 'size', size: size as Size } : { kind: 'unknown', text }
    }
    case 'model':
      return arg ? { kind: 'model', model: arg } : { kind: 'unknown', text }
    case 'effort':
      return arg ? { kind: 'effort', level: arg === 'default' ? null : arg.toLowerCase() } : { kind: 'unknown', text }
    case 'mode':
      if (/^read(-only)?$/i.test(arg)) return { kind: 'mode', mode: 'read-only' }
      if (/^(write|workspace-write)$/i.test(arg)) return { kind: 'mode', mode: 'workspace-write' }
      return { kind: 'unknown', text }
    default:
      return { kind: 'unknown', text }
  }
}

export type RunOutput = {
  model: string
  effort: string
  exit: number | null
  seconds: number | null
  session: string | null
  reply: string
}

/** pyr.sh / agy.sh output: a status line (`key=value …`), then the reply. */
export function parseRunOutput(stdout: string): RunOutput {
  const text = stdout.replace(/\r\n/g, '\n')
  const cut = text.indexOf('\n')
  const first = cut === -1 ? text : text.slice(0, cut)
  const reply = cut === -1 ? '' : text.slice(cut + 1).trim()
  const field = (key: string) => new RegExp(`(?:^| )${key}=(\\S*)`).exec(first)?.[1] ?? ''
  const exit = Number.parseInt(field('exit'), 10)
  const seconds = Number.parseInt(field('time'), 10)
  const session = field('session')
  return {
    model: field('model'),
    effort: field('effort'),
    exit: Number.isNaN(exit) ? null : exit,
    seconds: Number.isNaN(seconds) ? null : seconds,
    session: /^[A-Za-z0-9-]+$/.test(session) ? session : null,
    reply: first.startsWith('model=') ? reply : text.trim(),
  }
}

/** A prompt as a one-line title: cut at a word, with an ellipsis when it was longer. */
export function shortTitle(prompt: string, limit = 64): string {
  const line = prompt.replace(/\s+/g, ' ').trim()
  if (line.length <= limit) return line
  const cut = line.slice(0, limit + 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit / 2 ? cut.slice(0, space) : line.slice(0, limit)).replace(/[\s,.;:]+$/, '')}…`
}

/** The brief file the console hands the script: a title line for the run list, then the prompt. */
export function consoleBrief(prompt: string): string {
  return `${shortTitle(prompt)}\n\n${prompt.trim()}\n`
}

/** Adds entries, keeping the newest KEEP_ENTRIES. */
export function withEntries(state: ConsoleState, ...added: Entry[]): ConsoleState {
  return { ...state, entries: [...state.entries, ...added].slice(-KEEP_ENTRIES) }
}

/** The next entry id. */
export function nextId(state: ConsoleState): number {
  return (state.entries.at(-1)?.id ?? 0) + 1
}

/** A Windows path as Git Bash takes it: forward slashes. */
export function bashPath(path: string): string {
  return path.replace(/\\/g, '/')
}

/** The shared project folder in the working folder; all three agents read and add to it. */
export const PROJECT_DIR = '.bridge'

/** A new .bridge/project.md: the goal, who does what, its size, and room for decisions. */
export function projectTemplate(goal: string, date: string, size: Size = 'large'): string {
  return [
    `# Project: ${goal.trim()}`,
    '',
    'Shared by Claude, Codex and Gemini. Each reads this file and the end of log.md before working, and records decisions here.',
    '',
    '## Goal',
    '',
    goal.trim(),
    '',
    '## Who does what',
    '',
    '- Claude (lead): understands the request, plans, writes the UI and design-sensitive code, checks every result, talks to the user.',
    '- Codex: self-contained backend tasks with clear checks; reviews diffs (read-only, at most two rounds).',
    '- Gemini: an independent second plan; reviews interaction and copy.',
    '- You: decide after the plans are merged; say yes before anything is committed, pushed or published.',
    '',
    '## Size',
    '',
    `- ${size}`,
    '',
    '## Stage',
    '',
    '- ask',
    '',
    '## Decisions',
    '',
    `- ${date}: project started.`,
    '',
    '## Open questions',
    '',
  ].join('\n')
}

/** The goal named on project.md's first line, or null when it has none. */
export function projectGoal(text: string): string | null {
  const goal = /^# Project:\s*(.+)$/m.exec(text)?.[1]?.trim()
  return goal || null
}

/** One entry of .bridge/log.md, the shared log. */
export function logEntry(date: string, who: string, text: string): string {
  return `\n## ${date} · ${who}\n\n${text.trim()}\n`
}

/** The bullet lines under one `## <heading>` of project.md, without their dashes. */
export function projectSection(text: string, heading: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(line => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`)
  if (start === -1) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break
    const item = /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim()
    if (item) out.push(item)
  }
  return out
}

/** The newest `count` entries of log.md, newest first: who, the rest of the heading, and the text. */
export function logItems(text: string, count: number): LogItem[] {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n(?=## )/)
  const items: LogItem[] = []
  for (const block of blocks) {
    const [head = '', ...body] = block.split('\n')
    const parts = /^## (.+)$/.exec(head)?.[1]?.split(' · ')
    if (!parts || parts.length < 2) continue
    const [date = '', who = '', ...meta] = parts
    items.push({ date: date.trim(), who: who.trim(), meta: meta.join(' · ').trim(), text: body.join('\n').trim() })
  }
  return items.slice(-count).reverse()
}

/** A step of the workflow and who works in it, as the Flow tab draws it. */
export type Stage = { id: string; label: string; lanes: readonly Lane[]; who: string }
export type Lane = 'you' | 'claude' | 'gemini' | 'codex'

export const LANES: readonly Lane[] = ['you', 'claude', 'gemini', 'codex']

/**
 * How much workflow a task gets; Claude picks it at the start.
 * small: Claude alone (a fix, a question, a quick change).
 * medium: Claude leads; Codex builds a bounded block or reviews once, Gemini glances.
 * large: the full flow: two plans written apart, the owner decides, two review rounds.
 */
export type Size = 'small' | 'medium' | 'large'

export const SIZES: readonly Size[] = ['small', 'medium', 'large']

const SIZE_STAGES: Record<Size, readonly Stage[]> = {
  small: [
    { id: 'ask', label: 'Ask', lanes: ['you'], who: 'You' },
    { id: 'build', label: 'Do', lanes: ['claude'], who: 'Claude' },
    { id: 'ship', label: 'Check', lanes: ['claude', 'you'], who: 'Claude, You' },
  ],
  medium: [
    { id: 'ask', label: 'Ask', lanes: ['you'], who: 'You' },
    { id: 'plan', label: 'Plan', lanes: ['claude'], who: 'Claude' },
    { id: 'build', label: 'Build', lanes: ['claude', 'codex'], who: 'Claude, Codex' },
    { id: 'review', label: 'Review', lanes: ['gemini', 'codex'], who: 'Gemini or Codex' },
    { id: 'ship', label: 'Check & ship', lanes: ['claude', 'you'], who: 'Claude, You' },
  ],
  large: [
    { id: 'ask', label: 'Ask', lanes: ['you'], who: 'You' },
    { id: 'plan', label: 'Two plans', lanes: ['claude', 'gemini'], who: 'Claude, Gemini' },
    { id: 'merge', label: 'Merge', lanes: ['claude'], who: 'Claude' },
    { id: 'decide', label: 'Decide', lanes: ['you'], who: 'You' },
    { id: 'build', label: 'Build', lanes: ['claude', 'codex'], who: 'Claude, Codex' },
    { id: 'review', label: 'Review', lanes: ['gemini', 'codex'], who: 'Gemini, Codex' },
    { id: 'ship', label: 'Check & ship', lanes: ['claude', 'you'], who: 'Claude, You' },
  ],
}

/** The steps of a workflow of this size. */
export function stagesFor(size: Size, workflow: Workflow = DEFAULT_WORKFLOW): readonly Stage[] {
  return stagesOf(workflow, size)
}

/** The full (large) workflow's steps. */
export const STAGES: readonly Stage[] = SIZE_STAGES.large

/** The size project.md names under `## Size`; a project without one is large (the flow it was made for). */
export function projectSize(projectText: string): Size {
  const word = projectSection(projectText, 'Size')[0]?.toLowerCase().split(/\s/)[0]
  return (SIZES as readonly string[]).includes(word ?? '') ? (word as Size) : 'large'
}

/** The stage project.md names under `## Stage`, or null. */
export function currentStage(projectText: string): string | null {
  const id = projectSection(projectText, 'Stage')[0]?.toLowerCase().split(/\s/)[0]
  return id && STAGES.some(stage => stage.id === id) ? id : null
}

/** project.md with one `## <heading>` section set to a single bullet, added before Decisions when missing. */
function withSection(projectText: string, heading: string, value: string): string {
  const text = projectText.replace(/\r\n/g, '\n')
  const section = `## ${heading}\n\n- ${value}\n`
  const found = new RegExp(`## ${heading}\\n[\\s\\S]*?(?=\\n## |$)`).exec(text)
  if (found) return `${text.slice(0, found.index)}${section}${text.slice(found.index + found[0].length)}`
  const decisions = text.indexOf('## Decisions')
  if (decisions === -1) return `${text.trimEnd()}\n\n${section}`
  return `${text.slice(0, decisions)}${section}\n${text.slice(decisions)}`
}

/** project.md with its `## Stage` set to `id`. */
export function withStage(projectText: string, id: string): string {
  return withSection(projectText, 'Stage', id)
}

/**
 * project.md with its `## Size` set. A stage the new size has no step for moves
 * to the nearest step it does have (merge and decide fold into plan).
 */
export function withSize(projectText: string, size: Size): string {
  let text = withSection(projectText, 'Size', size)
  const stage = currentStage(text)
  if (stage && !stagesFor(size).some(one => one.id === stage)) {
    const order = STAGES.map(one => one.id)
    const kept = stagesFor(size).filter(one => order.indexOf(one.id) <= order.indexOf(stage))
    text = withStage(text, kept.at(-1)?.id ?? 'ask')
  }
  return text
}

/** The stage after `id` in a workflow of this size, or null at the end. */
export function nextStage(id: string | null, size: Size = 'large'): string | null {
  const stages = stagesFor(size)
  const index = stages.findIndex(stage => stage.id === id)
  return stages[index + 1]?.id ?? null
}
