// The Bridge app's main process: one window, the folder it works in, the
// conversations, and the IPC the window uses. Files and processes are only
// touched here; the window reaches them through preload.ts.

import { app, BrowserWindow, dialog, ipcMain, Notification, screen, shell } from 'electron'
import { existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { Job, Provider } from '../../../types'
import { CODEX_MODELS, shortTitle, SIZES, type Size, STAGES } from '../../../core/console'
import { fold } from '../../../core/flow'
import { EFFORTS, providerName } from '../../../core/jobs'
import { findBash } from './bash'
import { answerGate, flowPayload, isLive, safeId, setPaused, steerClaude, steerStep, type FlowPayload } from './flow'
import type { Mode, Paths, RunHandle, RunResult, Threads } from './contracts'
import { pluginPaths } from './paths'
import { startRun } from './runner'
import {
  appendLog,
  listRuns,
  readEfforts,
  readProject,
  readRun,
  setSize,
  setStage,
  startProject,
  writeEffort,
  writeHandoff,
} from './store'
import { finish, newThreads, reserve, reset } from './threads'

// dist/main.cjs -> app/dist -> app -> the plugin's folder.
const PLUGIN_ROOT = resolve(__dirname, '..', '..')
const paths: Paths = pluginPaths(PLUGIN_ROOT)
const SWEEP_MS = 2000
const KEEP_ENTRIES = 300

/** One line of a console transcript, as the window draws it. */
export type Line =
  | { id: number; kind: 'you'; provider: Provider; text: string; at: number }
  | {
      id: number
      kind: 'reply'
      provider: Provider
      text: string
      at: number
      ok: boolean
      stopped: boolean
      model: string
      effort: string
      seconds: number | null
    }
  | { id: number; kind: 'note'; provider: Provider; text: string; at: number }

/** A Line before it has an id; Omit spread over each kind of line. */
type NewLine = Line extends infer One ? (One extends Line ? Omit<One, 'id'> : never) : never

type Config = {
  workdir: string | null
  recent: string[]
  pinned: boolean
  /** Per folder: the conversation each provider continues. */
  sessions: Record<string, Record<Provider, string | null>>
  /** Per folder: each provider's transcript. */
  lines: Record<string, Record<Provider, Line[]>>
  codexModel: string
  mode: Mode
  /** The companion bar: shown while anything runs ('auto'), or never ('off'). */
  companion: 'auto' | 'off'
  /** Where the companion bar was left (its window's top-left), or null for the default corner. */
  companionAt: { x: number; y: number } | null
  /** The look: a terminal program, or drawn by hand. */
  theme: 'cli' | 'drawn'
  /** The flow shown, or null for the newest. */
  shownFlow: string | null
}

const DEFAULT_CONFIG: Config = {
  workdir: null,
  recent: [],
  pinned: false,
  sessions: {},
  lines: {},
  codexModel: 'gpt-6.2-sol',
  mode: 'read-only',
  companion: 'auto',
  companionAt: null,
  theme: 'cli',
  shownFlow: null,
}

let config: Config = { ...DEFAULT_CONFIG }
let window: BrowserWindow | null = null
let bash: string | null = null
let bashError = ''
let threads: Threads = newThreads()
const running = new Map<Provider, { handle: RunHandle; startedAt: number; title: string }>()
/** The newest runs as the last sweep read them (Claude's and the app's). */
let latestRuns: Job[] = []
let latestProject: Awaited<ReturnType<typeof readProject>> | null = null
let watchers: FSWatcher[] = []
let lastRunsText = ''
let lastProjectText = ''
/** The flow the window shows (the newest, or one the owner opened from the list). */
let latestFlow: FlowPayload = { flow: null, events: [], paused: false, flows: [] }
/** The newest flow: what notices, the companion, steers and answers go by, whichever one is shown. */
let liveFlow: FlowPayload = latestFlow
let lastFlowText = ''
/** Gates already announced, so each review notifies once. */
const announced = new Set<string>()

const configFile = () => join(app.getPath('userData'), 'bridge.json')

async function loadConfig() {
  try {
    config = { ...DEFAULT_CONFIG, ...(JSON.parse(await readFile(configFile(), 'utf8')) as Partial<Config>) }
  } catch {
    config = { ...DEFAULT_CONFIG }
  }
}

let saving: Promise<void> = Promise.resolve()
function saveConfig() {
  saving = saving.then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(configFile(), JSON.stringify(config))
  }).catch(() => undefined)
}

const now = () => Math.floor(Date.now() / 1000)

/** Local time as the shared log writes it: 2026-11-24 18:40. */
function stamp(date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

function send(channel: string, payload?: unknown) {
  window?.webContents.send(channel, payload)
}

// ------------------------------------------------------------- the folder

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

async function setWorkdir(path: string | null): Promise<{ error?: string }> {
  if (path && !isFolder(path)) return { error: 'That folder is gone' }
  // Already here (picked again): nothing to reset, and a running prompt keeps its slot.
  if (path === config.workdir && path !== null && lastProjectText !== '') {
    send('state', await snapshot())
    return {}
  }
  // A reply belongs to the folder its prompt was asked in: no switching mid-run.
  if (running.size && path !== config.workdir) return { error: 'Stop or finish the running prompt first' }
  config.workdir = path
  if (path) config.recent = [path, ...config.recent.filter(one => one !== path)].slice(0, 8)
  threads = newThreads()
  if (path) {
    const saved = config.sessions[path]
    if (saved) threads = { codex: { ...threads.codex, session: saved.codex }, gemini: { ...threads.gemini, session: saved.gemini } }
  }
  saveConfig()
  rewatch()
  lastProjectText = ''
  await sweep()
  send('state', await snapshot())
  return {}
}

function linesOf(provider: Provider): Line[] {
  const dir = config.workdir ?? ''
  return config.lines[dir]?.[provider] ?? []
}

/** Adds a line to `dir`'s transcript (the folder the prompt was asked in). */
function addLine(dir: string, provider: Provider, line: NewLine) {
  const all = (config.lines[dir] ??= { codex: [], gemini: [] })
  const list = all[provider]
  const id = (list.at(-1)?.id ?? 0) + 1
  all[provider] = [...list, { ...line, id } as Line].slice(-KEEP_ENTRIES)
  saveConfig()
  if (dir === config.workdir) send('lines', { provider, lines: all[provider] })
}

function rememberSessions(dir: string | null) {
  if (!dir) return
  config.sessions[dir] = { codex: threads.codex.session, gemini: threads.gemini.session }
  saveConfig()
}

async function snapshot() {
  // The efforts are read first; everything about the folder is taken together after,
  // with no wait in between, so a label and a transcript always belong to one folder.
  const efforts = await readEfforts(paths)
  return {
    workdir: config.workdir,
    recent: config.recent,
    pinned: config.pinned,
    codexModel: config.codexModel,
    mode: config.mode,
    efforts,
    companion: config.companion,
    theme: config.theme,
    models: [...CODEX_MODELS],
    effortChoices: { codex: [...EFFORTS.codex], gemini: [...EFFORTS.gemini] },
    bashError,
    delivery,
    claudeHere,
    threads: {
      codex: { continuing: Boolean(threads.codex.session), running: running.get('codex')?.startedAt ?? null },
      gemini: { continuing: Boolean(threads.gemini.session), running: running.get('gemini')?.startedAt ?? null },
    },
    lines: { codex: linesOf('codex'), gemini: linesOf('gemini') },
  }
}

// ------------------------------------------------------- watching the files

let sweepTimer: NodeJS.Timeout | null = null
let pending: NodeJS.Timeout | null = null

function soon() {
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => void sweep(), 150)
}

function rewatch() {
  for (const one of watchers) one.close()
  watchers = []
  const add = (path: string) => {
    if (!existsSync(path)) return
    try {
      const watcher = watch(path, { recursive: true }, soon)
      // A watch can fail later (a folder removed); the sweep carries on alone.
      watcher.on('error', () => watcher.close())
      watchers.push(watcher)
    } catch {
      // The 2 s sweep still catches changes where a watch cannot start.
    }
  }
  add(paths.runsDir)
  // Claude's status changes many times a turn: watched so the companion follows within a moment.
  add(join(PLUGIN_ROOT, 'status'))
  if (config.workdir) add(join(config.workdir, '.bridge'))
}

/** Hand-offs a Claude session has claimed (a .taken marker beside them), and any left an hour, are removed. */
async function tidyInbox() {
  let names: string[] = []
  try {
    names = await readdir(paths.inboxDir)
  } catch {
    return
  }
  const hourAgo = Date.now() - 60 * 60 * 1000
  for (const name of names.filter(one => one.endsWith('.json'))) {
    const file = join(paths.inboxDir, name)
    const taken = names.includes(`${name}.taken`)
    const old = await stat(file).then(info => info.mtimeMs < hourAgo, () => false)
    if (taken || old) {
      // The marker goes only once its hand-off is gone, so a hand-off is never offered twice.
      const removed = await unlink(file).then(
        () => true,
        () => false,
      )
      if (taken && removed) await unlink(`${file}.taken`).catch(() => undefined)
    }
  }
}

async function sweep() {
  void tidyInbox()
  try {
    const runs = await listRuns(paths, now(), 40)
    latestRuns = runs
    const runsText = JSON.stringify(runs)
    if (runsText !== lastRunsText) {
      lastRunsText = runsText
      send('runs', runs)
    }
    const dir = config.workdir
    if (dir) {
      const project = await readProject(dir)
      latestProject = project
      // The folder changed while it was read: this result is stale.
      if (dir !== config.workdir) return
      const projectText = JSON.stringify(project)
      if (projectText !== lastProjectText) {
        const hadProject = lastProjectText !== '' && JSON.parse(lastProjectText).exists
        lastProjectText = projectText
        send('project', project)
        if (!hadProject && project.exists) rewatch()
      }
      await sweepFlow(dir)
    } else if (lastFlowText !== 'none') {
      lastFlowText = 'none'
      latestFlow = { flow: null, events: [], paused: false, flows: [] }
      liveFlow = latestFlow
      send('flow', latestFlow)
    }
  } catch {
    // A file mid-write: the next sweep reads it.
  }
  latestClaude = await readClaudeStatus(config.workdir)
  await checkDelivery()
  const here = latestClaude?.here === true
  if (here !== claudeHere) {
    claudeHere = here
    send('state', await snapshot())
  }
  void updateCompanion()
}

// ----------------------------------------------------------- Claude's status

/** Claude's own status, written by the plugin (<plugin>/status/<folder>.json): thinking, a tool, or idle. */
type ClaudeStatus = { state: 'thinking' | 'tool' | 'idle'; detail: string; since: number; t: number; here?: boolean }
let latestClaude: ClaudeStatus | null = null

/** This folder's session if there is one, else the session that changed last; a busy status left for 15 minutes counts as idle. */
async function readClaudeStatus(workdir: string | null): Promise<ClaudeStatus | null> {
  const dir = join(PLUGIN_ROOT, 'status')
  let names: string[] = []
  try {
    names = (await readdir(dir)).filter(name => name.endsWith('.json'))
  } catch {
    return null
  }
  const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
  let best: (ClaudeStatus & { cwd: string }) | null = null
  for (const name of names) {
    try {
      const one = JSON.parse(await readFile(join(dir, name), 'utf8')) as ClaudeStatus & { cwd: string }
      if (typeof one.t !== 'number' || !['thinking', 'tool', 'idle'].includes(one.state)) continue
      const mine = workdir !== null && typeof one.cwd === 'string' && same(one.cwd, workdir)
      const bestMine = best !== null && workdir !== null && same(best.cwd, workdir)
      if (!best || (mine && !bestMine) || (mine === bestMine && one.t > best.t)) best = one
    } catch {
      // half-written: the next sweep reads it
    }
  }
  if (!best) return null
  const stale = best.state !== 'idle' && Date.now() / 1000 - best.t > 15 * 60
  // the plugin writes its status again every 30 s while the session is open
  const here = workdir !== null && same(best.cwd, workdir) && Date.now() / 1000 - best.t < 75
  return { state: stale ? 'idle' : best.state, detail: typeof best.detail === 'string' ? best.detail.slice(0, 120) : '', since: best.since, t: best.t, here }
}

// ------------------------------------------------------------------ flow

/** Reads the flow and sends it on when it changed; a review that just opened is announced. */
async function sweepFlow(dir: string) {
  const shown = config.shownFlow
  const live = await flowPayload(dir, null)
  const payload = shown && shown !== live.flow?.id ? await flowPayload(dir, shown) : live
  // The folder or the shown flow changed while this was read: it is stale.
  if (dir !== config.workdir || shown !== config.shownFlow) return
  liveFlow = live
  const text = JSON.stringify(payload)
  if (text !== lastFlowText) {
    const hadBridgeDir = lastFlowText !== '' && lastFlowText !== 'none'
    lastFlowText = text
    latestFlow = payload
    send('flow', payload)
    if (!hadBridgeDir) rewatch()
  }
  for (const s of fold(live.events, Date.now() / 1000).values()) {
    const key = `${dir}|${s.id}|${s.t0}`
    if (s.kind !== 'gate' || s.state !== 'waiting' || announced.has(key)) continue
    announced.add(key)
    announceGate(s.title ?? 'review the plan', s.summary ?? '', Boolean(s.noAuto))
  }
}

/** The review a click means: still waiting, in the live flow, and the very one that was on screen. */
function openGate(gate: string, t0: unknown) {
  const step = fold(liveFlow.events, Date.now() / 1000).get(gate)
  if (!step || step.kind !== 'gate' || step.state !== 'waiting') return null
  if (typeof t0 === 'number' && Math.abs(step.t0 - t0) > 0.01) return null
  return step
}

/** A review is waiting: say so outside the window too (the companion shows it on its own). */
function announceGate(title: string, summary: string, noAuto: boolean) {
  if (window && !window.isFocused()) window.flashFrame(true)
  if (Notification.isSupported() && !(window?.isFocused() ?? false)) {
    const note = new Notification({
      title: `Bridge · ${title.charAt(0).toUpperCase()}${title.slice(1)}`,
      body: [summary, noAuto ? 'Waits for your answer.' : 'Carries on by itself in 30 s.'].filter(Boolean).join(' · '),
      silent: false,
    })
    note.on('click', () => openMain())
    note.show()
  }
  void updateCompanion()
}

/** The look: the window's own colours follow it. */
/** Tells the Claude Code pane which look to draw in: <plugin>/status/look.json. */
async function writeLook() {
  try {
    await mkdir(join(PLUGIN_ROOT, 'status'), { recursive: true })
    await writeFile(join(PLUGIN_ROOT, 'status', 'look.json'), JSON.stringify({ theme: config.theme }))
  } catch {
    // the pane keeps its last look
  }
}

function applyTheme() {
  // the companion's shape follows the look: a square tile, or a pill
  if (companion) companion.setBounds(companionHome(companionSize().height))
  if (!SHOT_DIR) void writeLook()
  if (!window) return
  const dark = config.theme === 'cli'
  window.setBackgroundColor(dark ? '#151413' : '#FAF9F5')
  try {
    window.setTitleBarOverlay({ color: dark ? '#1f1d1a' : '#FAF9F5', symbolColor: dark ? '#8b857a' : '#5E5A54', height: 34 })
  } catch {
    // Not every platform has an overlay to recolour.
  }
}

/**
 * The steer box. `@codex …` / `@gemini …` go straight to that agent as a run
 * of their own in the flow; plain text goes to Claude: left for its next step
 * while it works through a flow, or as a new prompt when it is idle.
 */
async function steer(raw: string): Promise<{ ok?: boolean; error?: string; route?: string }> {
  const dir = config.workdir
  if (!dir) return { error: 'Pick a folder first' }
  const body = raw.trim()
  if (!body) return { error: 'Nothing to send' }
  const flowId = liveFlow.flow && liveFlow.flow.state !== 'done' ? liveFlow.flow.id : null
  const at = body.match(/^@(codex|gemini)\b\s*/i)
  if (at) {
    const who = (at[1] ?? '').toLowerCase() as Provider
    const ask = body.slice(at[0].length).trim()
    if (!ask) return { error: `Say what to ask ${providerName(who)}` }
    const step = `app-${who}-${Date.now().toString(36)}`
    const result = await runPrompt(who, ask, {
      BRIDGE_STEP: step,
      BRIDGE_STEP_TITLE: shortTitle(ask, 48),
      BRIDGE_WORKDIR: dir,
      BRIDGE_FLOW: 'on',
      ...(flowId ? { BRIDGE_FLOW_ID: flowId } : {}),
    })
    if ('error' in result && result.error) return { error: result.error }
    // the note appears only for a run that really started (a busy agent refuses)
    if (flowId) await steerStep(dir, flowId, who, ask)
    await sweep()
    return { ok: true, route: who }
  }
  if (flowId && isLive(liveFlow)) {
    await track('claude-next-step', await steerClaude(dir, flowId, body))
    await sweep()
    return { ok: true, route: 'claude-next-step' }
  }
  // With no workflow running, the box starts one: Claude in this folder gets it as a prompt.
  const file = await writeHandoff(paths, { cwd: dir, mode: 'send', text: startWords(body) })
  await track('claude-start', file)
  return { ok: true, route: 'claude-start' }
}

/** What Claude is sent when the box starts a workflow. */
const startWords = (goal: string) =>
  `Run this as a Bridge workflow: write the live flow with flow.sh (codex-bridge skill) so I can follow each step and answer the reviews in Bridge.\n\n${goal}`

// ------------------------------------------------------- did it arrive?

/**
 * The last message the box sent Claude, and what became of it: waiting, read
 * (Claude's session took the hand-off, or its next step read the note), or
 * nobody (no Claude Code session in the folder took a start within 20 s).
 */
type Delivery = { route: 'claude-start' | 'claude-next-step'; file: string; at: number; state: 'waiting' | 'read' | 'nobody' }
let delivery: Delivery | null = null

/** Starts watching a message; the window hears of it now, so it can say when its state changes. */
async function track(route: Delivery['route'], file: string) {
  delivery = { route, file, at: now(), state: 'waiting' }
  send('state', await snapshot())
}

/** A hand-off is gone or marked .taken once a session took it; a note is renamed .taken once Claude read it. */
async function checkDelivery() {
  const d = delivery
  if (!d || d.state === 'read') return
  const gone = !existsSync(d.file) || existsSync(`${d.file}.taken`)
  const next = gone ? 'read' : d.route === 'claude-start' && now() - d.at > 20 ? 'nobody' : d.state
  if (next !== d.state && delivery === d) {
    delivery = { ...d, state: next }
    send('state', await snapshot())
  }
}

/** Whether a Claude Code session with the plugin is open in this folder (its status file keeps fresh). */
let claudeHere = false

// ------------------------------------------------------------------ runs

async function runPrompt(provider: Provider, prompt: string, env?: Record<string, string>) {
  const workdir = config.workdir
  if (!workdir) return { error: 'Pick a folder first' }
  if (!bash) return { error: bashError || 'No bash found' }
  const id = `${provider}-${Date.now()}`
  const reserved = reserve(threads, provider, id)
  if (!reserved) return { error: `${provider === 'codex' ? 'Codex' : 'Gemini'} is still working` }
  threads = reserved
  const generation = threads[provider].generation
  addLine(workdir, provider, { kind: 'you', provider, text: prompt, at: now() })

  const handle = startRun(
    { provider, prompt, workdir, model: config.codexModel, mode: config.mode, session: threads[provider].session, ...(env ? { env } : {}) },
    { paths, bash },
  )
  running.set(provider, { handle, startedAt: now(), title: shortTitle(prompt, 56) })
  void updateCompanion()
  send('state', await snapshot())

  void handle.done.then(async (result: RunResult) => {
    running.delete(provider)
    void updateCompanion()
    threads = finish(threads, provider, id, generation, result.session)
    rememberSessions(workdir)
    addLine(workdir, provider, {
      kind: 'reply',
      provider,
      text: result.reply || (result.stopped ? 'Stopped.' : result.stderr.trim() || 'No reply.'),
      at: now(),
      ok: result.ok,
      stopped: result.stopped,
      model: result.model,
      effort: result.effort,
      seconds: result.seconds,
    })
    send('state', await snapshot())
    if (window && !window.isFocused() && Notification.isSupported()) {
      new Notification({
        title: `${provider === 'codex' ? 'Codex' : 'Gemini'} ${result.ok ? 'replied' : result.stopped ? 'stopped' : 'failed'}`,
        body: (result.reply || result.stderr).slice(0, 140),
        silent: true,
      }).show()
    }
  })
  return { ok: true }
}

// ------------------------------------------------------------------- IPC

/**
 * One IPC call. Only this app's own window may call, and every argument is
 * checked here at run time (the window's types are not trusted).
 */
function handle<T extends unknown[]>(channel: string, fn: (...args: T) => unknown, fromCompanion = false) {
  ipcMain.handle(channel, (event, ...args) => {
    const isCompanion = fromCompanion && companion !== null && event.sender === companion.webContents
    if (!isCompanion && (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)) {
      throw new Error('Not from the Bridge window')
    }
    return fn(...(args as T))
  })
}

const PROVIDERS: readonly string[] = ['codex', 'gemini']

/** A run id is a folder name under runs/, never a path. */
function runId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w.-]+$/.test(value) || value.startsWith('.')) throw new Error('Bad run id')
  return value
}

function provider(value: unknown): Provider {
  if (typeof value !== 'string' || !PROVIDERS.includes(value)) throw new Error('Unknown provider')
  return value as Provider
}

function text(value: unknown, limit = 200_000): string {
  if (typeof value !== 'string') throw new Error('Expected text')
  return value.slice(0, limit)
}

function wireIpc() {
  handle('state', () => snapshot())
  handle('flow', () => latestFlow)
  const gateCall = async (gate: unknown, answer: unknown, note: unknown, t0: unknown) => {
    const dir = config.workdir
    if (!dir) return { error: 'Pick a folder first' }
    if (answer !== 'approve' && answer !== 'decline' && answer !== 'steer') throw new Error('Unknown answer')
    const step = openGate(safeId(gate), t0)
    if (!step) return { error: 'that review is already closed' }
    if (answer === 'steer' && step.noAuto) return { error: 'this one needs a yes or a not now' }
    const result = await answerGate(dir, liveFlow.flow?.id ?? null, step.id, answer, typeof note === 'string' ? note.slice(0, 4000) : undefined)
    await sweep()
    return result
  }
  handle('answerGate', gateCall, true)
  const pauseCall = async (on: unknown) => {
    const dir = config.workdir
    if (!dir) return { error: 'Pick a folder first' }
    await setPaused(dir, on === true, liveFlow.flow?.id ?? null)
    await sweep()
    return { ok: true }
  }
  handle('setPaused', pauseCall, true)
  handle('steer', async (body: unknown) => steer(text(body, 20_000)))
  handle('setTheme', async (theme: unknown) => {
    config.theme = theme === 'drawn' ? 'drawn' : 'cli'
    saveConfig()
    applyTheme()
    lastCompanion = ''
    void updateCompanion()
    send('state', await snapshot())
  })
  handle('showFlow', async (id: unknown) => {
    config.shownFlow = id === null ? null : safeId(id)
    saveConfig()
    lastFlowText = ''
    await sweep()
  })
  handle('pickFolder', async () => {
    if (!window) return null
    const picked = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
    const path = picked.canceled ? null : (picked.filePaths[0] ?? null)
    if (!path) return null
    const result = await setWorkdir(path)
    return result.error ? { error: result.error } : path
  })
  // Only a folder from the recent list; any other goes through the picker.
  handle('setWorkdir', async (path: unknown) => {
    if (typeof path !== 'string' || !config.recent.includes(path)) return { error: 'Not a recent folder' }
    return setWorkdir(path)
  })
  handle('send', async (who: unknown, prompt: unknown) => runPrompt(provider(who), text(prompt)))
  handle('stop', async (who: unknown) => {
    await running.get(provider(who))?.handle.stop()
  })
  handle('newThread', async (who: unknown) => {
    const one = provider(who)
    threads = reset(threads, one)
    rememberSessions(config.workdir)
    addLine(config.workdir ?? '', one, { kind: 'note', provider: one, text: 'New conversation', at: now() })
    send('state', await snapshot())
  })
  handle('clear', async (who: unknown) => {
    const one = provider(who)
    const dir = config.workdir ?? ''
    if (config.lines[dir]) config.lines[dir][one] = []
    saveConfig()
    send('lines', { provider: one, lines: [] })
  })
  handle('setEffort', async (who: unknown, effort: unknown) => {
    const one = provider(who)
    const level = effort === null ? null : text(effort, 20)
    if (level !== null && !(EFFORTS[one] as readonly string[]).includes(level)) throw new Error('Unknown effort')
    const efforts = await writeEffort(paths, one, level)
    send('state', await snapshot())
    return efforts
  })
  handle('setModel', async (model: unknown) => {
    if (typeof model !== 'string' || !(CODEX_MODELS as readonly string[]).includes(model)) throw new Error('Unknown model')
    config.codexModel = model
    saveConfig()
    send('state', await snapshot())
  })
  handle('setMode', async (mode: unknown) => {
    config.mode = mode === 'workspace-write' ? 'workspace-write' : 'read-only'
    saveConfig()
    send('state', await snapshot())
  })
  handle('project', async () => (config.workdir ? readProject(config.workdir) : null))
  handle('startProject', async (goal: unknown) => {
    const dir = config.workdir
    if (!dir) return 'no-folder'
    const name = text(goal, 300).trim()
    if (!name) return 'no-goal'
    const result = await startProject(dir, name, stamp().slice(0, 10))
    if (result === 'created') await appendLog(dir, 'You', `Started the project: ${name}`, stamp())
    await sweep()
    return result
  })
  handle('setStage', async (stageId: unknown) => {
    const dir = config.workdir
    if (!dir || typeof stageId !== 'string' || !STAGES.some(stage => stage.id === stageId)) return
    await setStage(dir, stageId)
    await sweep()
  })
  handle('setSize', async (size: unknown) => {
    const dir = config.workdir
    if (!dir || typeof size !== 'string' || !(SIZES as readonly string[]).includes(size)) return
    await setSize(dir, size as Size)
    await sweep()
  })
  handle('addNote', async (note: unknown) => {
    const dir = config.workdir
    const body = text(note, 20_000).trim()
    if (!dir || !body) return
    await appendLog(dir, 'You', body, stamp())
    await sweep()
  })
  handle('runs', async () => listRuns(paths, now(), 40))
  // A run id is a folder name under runs/: never a path.
  handle('run', async (id: unknown) => readRun(paths, runId(id)))
  // The whole reply (the view shows a clipped one), for Copy and the hand-offs.
  handle('runReply', async (id: unknown) => readFile(join(paths.runsDir, runId(id), 'result.md'), 'utf8').catch(() => ''))
  handle('handoff', async (mode: unknown, body: unknown) => {
    if (!config.workdir) return { error: 'Pick a folder first' }
    await writeHandoff(paths, { cwd: config.workdir, mode: mode === 'send' ? 'send' : 'fill', text: text(body) })
    return { ok: true }
  })
  handle('pin', async () => {
    config.pinned = !config.pinned
    window?.setAlwaysOnTop(config.pinned)
    saveConfig()
    send('state', await snapshot())
  })
  handle('companionToggle', async () => {
    config.companion = config.companion === 'off' ? 'auto' : 'off'
    saveConfig()
    // Turned on while nothing runs: show it for a few seconds so you see where it is.
    previewUntil = config.companion === 'auto' ? Date.now() + 5000 : 0
    await updateCompanion()
    send('state', await snapshot())
  })
  handle('companionOpen', async () => openMain(), true)
  handle('openFolder', async () => {
    if (config.workdir) await shell.openPath(config.workdir)
  })
}

// ------------------------------------------------------------- companion
// A small strip that floats over other windows while Codex or Gemini works,
// whoever started the job, and fades about ten seconds after all is quiet.

let companion: BrowserWindow | null = null
let idleSince: number | null = null
let previewUntil = 0
let lastCompanion = ''

// The companion's window, per look: the terminal look is a square tile (108 px), the drawn look a
// pill (252 x 46). Each window adds 8 px round it for the shadow, and keeps 30 px above for the
// row that opens on hover: the window never changes size on hover (that made the bar flash).
const LINGER_MS = 10_000
const ROW_ROOM = 30
function companionSize() {
  const bar = config.theme === 'cli' ? { width: 124, height: 124 } : { width: 268, height: 62 }
  return { width: bar.width, height: bar.height + ROW_ROOM }
}

/** Where the companion sits: where it was left (by its bottom-right corner, so a size change keeps it in its corner), kept on screen. */
function companionHome(height: number) {
  const area = screen.getPrimaryDisplay().workArea
  const { width } = companionSize()
  const at = config.companionAt
  const right = at ? Math.min(Math.max(at.x, area.x + width), area.x + area.width) : area.x + area.width - 16
  const bottom = at ? Math.min(Math.max(at.y, area.y + height), area.y + area.height) : area.y + area.height - 12
  return { x: right - width, y: bottom - height, width, height }
}

function createCompanion() {
  companion = new BrowserWindow({
    ...companionHome(companionSize().height),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'Bridge companion',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  companion.setAlwaysOnTop(true, 'floating')
  // the room kept above the bar lets clicks through until the pointer is on the bar (watchRow)
  companion.setIgnoreMouseEvents(true)
  barHover = false
  watchRow()
  companion.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  companion.webContents.on('will-navigate', event => event.preventDefault())
  // Where it was dragged to: remembered by its bottom-right corner, so hovering (which grows it upward) never shifts it.
  companion.on('moved', () => {
    if (!companion) return
    const bounds = companion.getBounds()
    config.companionAt = { x: bounds.x + bounds.width, y: bounds.y + bounds.height }
    saveConfig()
  })
  companion.on('closed', () => {
    companion = null
  })
  void companion.loadFile(join(__dirname, 'companion.html'))
  companion.webContents.once('did-finish-load', () => {
    lastCompanion = ''
    void updateCompanion()
  })
}

// The hover row. The main process watches the pointer (about 15 times a second while the bar is up)
// rather than the page: a window that lets clicks through hears of a "mouse leave" right after each
// move on Windows, which opened and shut the row at once. On the bar (or on the open row) the
// window takes clicks; anywhere else, clicks go through to what is underneath.
let barHover = false
let rowOpen = false
let rowCloseAt = 0
let rowTimer: NodeJS.Timeout | null = null
const ROW_LINGER_MS = 350

function setRow(open: boolean) {
  if (rowOpen === open) return
  rowOpen = open
  companion?.webContents.send('companion-row', open)
}

function watchRow() {
  if (rowTimer) return
  rowTimer = setInterval(() => {
    if (!companion || companion.isDestroyed() || !companion.isVisible()) {
      if (rowOpen) setRow(false)
      return
    }
    const p = screen.getCursorScreenPoint()
    const b = companion.getBounds()
    const barW = b.width - 16, barH = b.height - ROW_ROOM - 16
    const bottom = b.y + b.height - 8
    const over = p.x >= b.x + 8 && p.x < b.x + 8 + barW && p.y >= bottom - barH - (rowOpen ? ROW_ROOM : 0) && p.y < bottom
    if (over !== barHover) {
      barHover = over
      companion.setIgnoreMouseEvents(!over)
    }
    if (over) {
      rowCloseAt = 0
      setRow(true)
    } else if (rowOpen) {
      if (!rowCloseAt) rowCloseAt = Date.now() + ROW_LINGER_MS
      else if (Date.now() >= rowCloseAt) {
        rowCloseAt = 0
        setRow(false)
      }
    }
  }, 66)
}

function openMain() {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/** What the bar needs: the flow (it folds it itself), the look, and Claude's own runs when there is no flow. */
function companionState() {
  const now = Date.now() / 1000
  const steps = [...fold(liveFlow.events, now).values()]
  const flowBusy = steps.some(step => step.state === 'running' && step.kind !== 'gate' && step.kind !== 'steer')
  const gate = steps.some(step => step.state === 'waiting' && step.kind === 'gate')
  const runs: { who: string; title: string; since: number }[] = []
  for (const [provider, run] of running) runs.push({ who: provider, title: run.title, since: run.startedAt })
  for (const job of latestRuns) {
    if (job.state === 'running' && job.origin !== 'app') runs.push({ who: job.provider, title: job.title, since: now - job.seconds })
  }
  const claude = latestClaude
  const claudeBusy = claude !== null && claude.state !== 'idle'
  return {
    busy: flowBusy || gate || runs.length > 0 || claudeBusy,
    theme: config.theme,
    flow: liveFlow,
    runs,
    claude,
  }
}

/** Shows, updates or fades the bar: while anything runs or waits for you, and a little after. */
async function updateCompanion() {
  if (!companion) return
  const state = companionState()
  const nowMs = Date.now()
  if (state.busy) idleSince = null
  else if (idleSince === null) idleSince = nowMs
  const lingering = idleSince !== null && nowMs - idleSince < LINGER_MS
  const visible = config.companion === 'auto' && (state.busy || (lingering && lastCompanion !== '') || nowMs < previewUntil)

  const text = JSON.stringify({ ...state, visible })
  if (text === lastCompanion) return
  lastCompanion = text
  if (visible && !companion.isVisible()) {
    const height = companionSize().height
    companion.setBounds(companionHome(height))
    companion.showInactive()
  }
  companion.webContents.send('companion', { ...state, visible })
  if (!visible && companion.isVisible()) {
    setTimeout(() => {
      if (companion && JSON.parse(lastCompanion).visible === false) companion.hide()
    }, 300)
  }
}

// ---------------------------------------------------------------- window

/** The folder to open: --workdir64 (base64url, safe for any letters) first, then --workdir. */
function workdirFromArgs(argv: string[]): string | null {
  const encoded = argv.indexOf('--workdir64')
  if (encoded !== -1 && argv[encoded + 1]) {
    try {
      const path = Buffer.from(argv[encoded + 1]!, 'base64url').toString('utf8')
      if (isFolder(path)) return resolve(path)
    } catch {
      // fall back to the plain one
    }
  }
  const at = argv.indexOf('--workdir')
  const path = at === -1 ? null : (argv[at + 1] ?? null)
  return path && isFolder(path) ? resolve(path) : null
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    title: 'Bridge',
    backgroundColor: config.theme === 'cli' ? '#151413' : '#FAF9F5',
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: config.theme === 'cli' ? { color: '#1f1d1a', symbolColor: '#8b857a', height: 34 } : { color: '#FAF9F5', symbolColor: '#5E5A54', height: 34 },
    alwaysOnTop: config.pinned,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Capture mode photographs the window while the companion sits on top: keep it painting.
      backgroundThrottling: !SHOT_DIR,
    },
  })
  window.once('ready-to-show', () => window?.show())
  // Nothing outside the app's own page opens inside it.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', event => event.preventDefault())
  void window.loadFile(join(__dirname, 'index.html'))
  window.on('closed', () => {
    window = null
    app.quit()
  })
}

// Development only: BRIDGE_SHOT_DIR=<folder> opens the app with a throwaway
// profile, photographs each screen into that folder, sends one prompt from the
// BRIDGE_SHOT_PROMPT variable (if set) to Gemini, photographs the reply, and quits.
const SHOT_DIR = process.env.BRIDGE_SHOT_DIR
// A fresh profile per capture, unless BRIDGE_SHOT_PROFILE names one to reuse.
if (SHOT_DIR) app.setPath('userData', process.env.BRIDGE_SHOT_PROFILE || join(SHOT_DIR, `profile-${Date.now()}`))

async function shoot() {
  if (!SHOT_DIR || !window) return
  const web = window.webContents
  const wait = (ms: number) => new Promise(done => setTimeout(done, ms))
  const snap = async (name: string) => writeFile(join(SHOT_DIR, `${name}.png`), (await web.capturePage()).toPNG())
  const snapCompanion = async (name: string) => {
    if (!companion) return
    await writeFile(join(SHOT_DIR, `${name}.png`), (await companion.webContents.capturePage()).toPNG())
  }
  const look = async (theme: 'cli' | 'drawn') => {
    config.theme = theme
    applyTheme()
    lastCompanion = ''
    void updateCompanion()
    send('state', await snapshot())
    await wait(1600)
  }
  /** Frames per second over two seconds of the live page, and the slowest frame. */
  const fps = () => web.executeJavaScript(`new Promise(done => { const times = []; let last = performance.now(); const start = last; const tick = now => { times.push(now - last); last = now; if (now - start < 2000) requestAnimationFrame(tick); else { times.sort((a, b) => a - b); done({ fps: Math.round(times.length / ((now - start) / 1000)), slowestMs: Math.round(times[times.length - 1]), p95Ms: Math.round(times[Math.floor(times.length * 0.95)]) }) } }; requestAnimationFrame(tick) })`)
  const report: Record<string, unknown> = {}
  previewUntil = Date.now() + 120_000
  // BRIDGE_SHOT_E2E: wait for a review to open in the flow, then answer it with a real click on the drawn look's Approve.
  // Only in a test project made for it (it holds .bridge/e2e-fixture), and only a timed review.
  if (process.env.BRIDGE_SHOT_E2E && config.workdir && existsSync(join(config.workdir, '.bridge', 'e2e-fixture'))) {
    await look('drawn')
    let gate: ReturnType<typeof openGate> = null
    for (let i = 0; i < 240 && !gate; i++) {
      gate = [...fold(liveFlow.events, Date.now() / 1000).values()].find(step => step.kind === 'gate' && step.state === 'waiting' && !step.noAuto) ?? null
      if (!gate) await wait(500)
    }
    await wait(1500)
    await snap('e2e-1-review')
    if (gate) {
      const selector = JSON.stringify(`.d-card[data-id="${gate.id}"] .d-btn[data-answer="approve"]:not(:disabled)`)
      report.clicked = await web.executeJavaScript(`(() => { const b = document.querySelector(${selector}); if (!b) return false; b.click(); return true })()`)
      await wait(1500)
      // the click must have become the review's answer, written by the app
      const answer = await readFile(join(config.workdir, '.bridge', 'control', `gate-${gate.id}.json`), 'utf8').catch(() => '')
      report.answered = answer.includes('"by":"you"') && answer.includes('"approve"')
    }
    await wait(2500)
    await snap('e2e-2-after')
    await look('cli')
    await snap('e2e-3-cli')
  }
  for (const theme of ['cli', 'drawn'] as const) {
    await look(theme)
    await snap(`${theme}-flow`)
    report[theme] = await fps()
    // three moments of the companion's motion, to check the step it shows by animation
    await snapCompanion(`${theme}-companion`)
    await wait(450)
    await snapCompanion(`${theme}-companion-b`)
    await wait(450)
    await snapCompanion(`${theme}-companion-c`)
    if (companion) {
      // the row as the pointer on the bar opens it, then shut again
      setRow(true)
      await wait(700)
      await snapCompanion(`${theme}-companion-open`)
      setRow(false)
      await wait(600)
    }
  }
  const errors = await web.executeJavaScript(`window.__errors || []`).catch(() => [])
  await writeFile(join(SHOT_DIR, 'report.json'), JSON.stringify({ ...report, errors }, null, 2))
  app.quit()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const dir = workdirFromArgs(argv)
    if (dir && dir !== config.workdir) void setWorkdir(dir)
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  void app.whenReady().then(async () => {
    await loadConfig()
    if (!SHOT_DIR) void writeLook()
    const found = findBash({
      env: process.env,
      platform: process.platform,
      exists: path => existsSync(path),
      which: command => {
        for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
          for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
            const candidate = join(dir, command + ext)
            if (dir && existsSync(candidate)) return candidate
          }
        }
        return null
      },
    })
    if ('path' in found) bash = found.path
    else bashError = found.error
    wireIpc()
    const fromArgs = workdirFromArgs(process.argv)
    await setWorkdir(fromArgs ?? config.workdir)
    createWindow()
    createCompanion()
    sweepTimer = setInterval(() => void sweep(), SWEEP_MS)
    if (SHOT_DIR) window?.once('ready-to-show', () => void shoot())
  })

  app.on('window-all-closed', () => app.quit())

  // Every way out (closing the window, Cmd+Q, app.quit) comes through here once:
  // stop every run's whole process tree first, giving up after 8 s, then quit.
  let isLeaving = false
  app.on('before-quit', event => {
    if (isLeaving) return
    isLeaving = true
    if (sweepTimer) clearInterval(sweepTimer)
    for (const one of watchers) one.close()
    if (!running.size) return
    event.preventDefault()
    const stops = [...running.values()].map(({ handle: run }) => run.stop().catch(() => undefined))
    void Promise.race([Promise.all(stops), new Promise(done => setTimeout(done, 8000))]).then(() => app.quit())
  })
}
