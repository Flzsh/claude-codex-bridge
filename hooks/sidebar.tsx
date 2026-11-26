// The Bridge pane: a sidebar in Claude Code that shows the workflow in the
// Bridge app's look (terminal or drawn, as the app is set): the whole workflow
// on top, every step in its agent's lane, and below it the step in focus (what
// it is doing, or the review's points and countdown). It answers a review
// (approve, pause, decline, or a change), takes a note for Claude's next step,
// starts a workflow when none runs, and lists the Codex and Gemini runs.
//
// Every answer goes through flow.sh, the same writer the app and Claude use.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { SidebarState } from '../types'
import { bashPath } from '../core/console'
import { currentFlow, ofFlow, parseFlow, type FlowEvent } from '../core/flow'
import { ago, emptyAlt, emptySvg, lastFlow, onWhite, PANE_THEME, PANE_THEME_WHITE, paneAlt, paneModel, paneSvg, pictureWidth, type EmptyModel, type PaneTheme } from '../core/pane'
import { parseWorkflow, type Workflow } from '../core/workflow'
import { IDLE_H, SIDEBAR_W, sidebarView, type FlowHead, type Look } from '../core/sidebar'
import { findBash, openConsole } from './console-pane'
import { openApp } from './launch'
import { readText, recentRuns, runsSection } from './runs'
import { currentStatus } from './status'

export const PANE = 'bridge'
const TITLE = 'Bridge'
/** The flow file is not read past this size (flow.sh starts a new one at 2 MB). */
const MAX_FLOW = 8 * 1024 * 1024
/** How long "Claude read your note" stays. */
const READ_SHOWN = 30

const NEW_SIDEBAR: SidebarState = {
  look: 'cli',
  svg: '',
  alt: '',
  height: IDLE_H,
  flow: null,
  live: false,
  finished: false,
  paused: false,
  gate: null,
  claude: { busy: false, detail: '' },
  notes: { waiting: 0, readAt: null },
  notice: null,
  sends: 0,
  opened: false,
}
// Change the tag when SidebarState's fields change: it declines what an earlier version stored.
const sidebar = atom({ plugin: 'codex-bridge', key: 'sidebar' } as const, NEW_SIDEBAR, { shape: 'sidebar-2' })

// Set at session start.
let cwd = ''
let root = ''
let bash = 'bash'
// The flow file as last read: its size and time, and its events.
let flowSig = ''
let events: FlowEvent[] = []
// The picture is made again only when what it shows changes, so its motion is not restarted.
let pictureKey = ''
let picture = { svg: '', alt: '', height: IDLE_H }
let notesBefore = 0
// The pane's width in cells, as it last drew: the picture is laid out for it at the next poll.
let paneColumns = 0

export async function startSidebar($: EngineInterface, sessionCwd: string) {
  cwd = sessionCwd
  root = $.plugin.root.replace(/[\\/]+$/, '')
  bash = await findBash($, root)
  // Opened beside the chat without taking the keyboard, once a session: a reload of the
  // plugin runs this again, and a pane the person closed stays closed.
  if ((await read($, sidebar)).opened) return
  await update($, sidebar, state => ({ ...state, opened: true }))
  await $.ui.open({ id: PANE, title: TITLE })
}

export async function openSidebar($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE, focus: true })
}

/** The app's look, as it writes it for this pane, and whether the terminal look sits on white
 * (for Claude Code in its light theme); the terminal look on dark until it has. */
async function readLook($: EngineInterface): Promise<{ look: Look; white: boolean }> {
  try {
    const saved = JSON.parse(await readText($, `${root}/status/look.json`)) as { theme?: string; pane?: string }
    const look: Look = saved.theme === 'drawn' ? 'drawn' : 'cli'
    return { look, white: look === 'cli' && saved.pane === 'white' }
  } catch {
    return { look: 'cli', white: false }
  }
}

/** The colours the pane is drawn in: the look's, or the terminal look's on white. */
export function paneTheme(look: Look, white?: boolean): PaneTheme {
  return look === 'cli' && white ? PANE_THEME_WHITE : PANE_THEME[look]
}

/** The owner's steps (the app's step editor writes them), else the defaults. */
async function readWorkflow($: EngineInterface): Promise<Workflow> {
  try {
    const file = `${root}/workflow.json`
    return parseWorkflow((await $.fs.exists(file)) ? await readText($, file) : null)
  } catch {
    return parseWorkflow(null)
  }
}

/** The flow file's events, read again only when the file changed. */
async function readEvents($: EngineInterface): Promise<FlowEvent[]> {
  const file = `${cwd}/.bridge/flow.jsonl`
  let sig = ''
  try {
    if (await $.fs.exists(file)) {
      const stat = await $.fs.stat(file)
      sig = stat.size > MAX_FLOW ? 'too-big' : `${stat.size}:${stat.mtimeMs}`
    }
  } catch {
    sig = ''
  }
  if (sig !== flowSig) {
    flowSig = sig
    events = sig && sig !== 'too-big' ? parseFlow(await readText($, file)) : []
  }
  return events
}

/** A flow's control folders: its own, then the shared one (older builds, or no flow). */
function controlDirs(flow: string | null): string[] {
  const shared = `${cwd}/.bridge/control`
  return flow && /^[\w.-]{1,80}$/.test(flow) && !flow.startsWith('.') ? [`${shared}/${flow}`, shared] : [shared]
}

/** Notes for Claude not yet read: flow.sh marks one .taken when Claude's next step reads it. */
async function waitingNotes($: EngineInterface, flow: string | null): Promise<number> {
  let count = 0
  for (const dir of controlDirs(flow)) {
    try {
      if (await $.fs.exists(dir)) count += (await $.fs.list(dir)).filter(entry => entry.kind === 'file' && /^steer-.+\.json$/.test(entry.name)).length
    } catch {
      // gone between the look and the list
    }
  }
  return count
}

/** Keeps the pane in step with the flow, the app's look and Claude's own state. */
export async function pollSidebar($: EngineInterface) {
  if (!cwd) return
  const now = (await $.clock.now()) / 1000
  const { look, white } = await readLook($)
  const all = await readEvents($)
  const id = currentFlow(all)
  const mine = id ? ofFlow(all, id) : []
  const start = mine.find(e => e.kind === 'flow' && e.title !== undefined)
  const head: FlowHead | null =
    id && start
      ? {
          id,
          title: start.title ?? 'workflow',
          size: typeof start.size === 'string' ? start.size : null,
          state: mine.some(e => e.kind === 'flow' && e.state === 'done') ? 'done' : null,
        }
      : null
  // paused by the flow's own pause, or a shared one (older builds)
  let paused = false
  for (const dir of controlDirs(id)) if (await $.fs.exists(`${dir}/pause.json`)) paused = true
  const workflow = await readWorkflow($)
  const view = sidebarView(mine, head, paused, now, workflow)
  const status = currentStatus()
  const busy = status.state !== 'idle'
  const model = view ? paneModel(mine, head, paused, now, busy, workflow) : null

  // with no workflow: the shape of one, waiting for you, then the last one and the last runs
  const empty: EmptyModel | null = model
    ? null
    : {
        busy,
        last: lastFlow(all, id, now),
        runs: recentRuns().map(job => ({ provider: job.provider, title: job.title, state: job.state, ago: job.endedAgo === null ? 'running' : ago(job.endedAgo) })),
      }

  // the picture is made again only when what it shows, or the pane's width, changes (it moves by itself)
  const width = pictureWidth(paneColumns)
  const key = JSON.stringify([look, white, width, model ?? empty])
  if (key !== pictureKey) {
    pictureKey = key
    // bare: the pane around it is drawn in the look, its ground and edge
    const drawn = model ? paneSvg(model, look, now, width, 'bare') : emptySvg(empty!, look, width, 'bare')
    const svg = white ? onWhite(drawn) : drawn
    picture = {
      svg,
      alt: model ? paneAlt(model) : emptyAlt(empty!),
      height: Number(/height="(\d+)"/.exec(svg)?.[1] ?? IDLE_H),
    }
  }

  const waiting = await waitingNotes($, id)
  const before = await read($, sidebar)
  const readAt = waiting < notesBefore ? now : before.notes.readAt !== null && now - before.notes.readAt < READ_SHOWN ? before.notes.readAt : null
  notesBefore = waiting

  const next: SidebarState = {
    ...before,
    look,
    white,
    ...picture,
    flow: view ? view.id : null,
    live: Boolean(view && !view.finished),
    finished: Boolean(view?.finished),
    paused,
    gate: view?.gate ? { id: view.gate.id, title: view.gate.title, noAuto: view.gate.noAuto } : null,
    claude: { busy, detail: status.state === 'tool' ? status.detail : status.state === 'thinking' ? 'thinking' : '' },
    notes: { waiting, readAt },
  }
  if (JSON.stringify(next) !== JSON.stringify(before)) await update($, sidebar, () => next)
}

async function say($: EngineInterface, notice: string | null) {
  await update($, sidebar, state => ({ ...state, notice }))
}

/** Runs flow.sh in this session's folder, as the app and Claude do. */
/** `flow`: the flow the pane shows, so an answer never lands on one that started meanwhile. */
async function flowSh($: EngineInterface, args: string[], flow: string | null = null): Promise<{ ok: boolean; out: string }> {
  try {
    const result = await $.process.run([bash, bashPath(`${root}/skills/codex-bridge/flow.sh`), ...args], {
      cwd,
      env: { BRIDGE_WORKDIR: cwd, ...(flow ? { BRIDGE_FLOW_ID: flow } : {}) },
      timeoutMs: 20_000,
    })
    return { ok: result.exitCode === 0, out: `${result.stdout}\n${result.stderr}`.trim() }
  } catch (error) {
    return { ok: false, out: error instanceof Error ? error.message : String(error) }
  }
}

async function answer($: EngineInterface, kind: 'approve' | 'decline' | 'steer', text?: string) {
  const { gate } = await read($, sidebar)
  if (!gate) return say($, 'That review is already closed.')
  const run = await flowSh($, ['answer', kind, '--gate', gate.id, ...(text ? ['--text', text] : [])], (await read($, sidebar)).flow)
  if (!run.ok) return say($, `Could not answer: ${run.out.split('\n').at(-1) ?? 'flow.sh failed'}`)
  if (run.out.includes('ANSWER=taken')) return say($, 'Already answered (the time ran out, or the app answered first).')
  await say($, kind === 'approve' ? 'Approved. Claude carries on.' : kind === 'decline' ? 'Declined. Claude stops and asks you what instead.' : 'Sent. Claude applies the change and opens a new review.')
  await pollSidebar($)
}

async function setPause($: EngineInterface) {
  const { paused } = await read($, sidebar)
  const run = await flowSh($, ['answer', paused ? 'resume' : 'pause'], (await read($, sidebar)).flow)
  await say($, run.ok ? (paused ? 'Resumed.' : 'Paused. Claude waits at its next step.') : 'Could not change the pause.')
  await pollSidebar($)
}

export function registerSidebar(on: On) {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = table
    const st = await read($, sidebar)
    // the next poll lays the picture out for this width: a seat that draws it, at its full size
    // (not the terminal, nor the small form of a minimized pane)
    if (e.surface !== 'terminal' && e.props.placement !== 'widget') paneColumns = e.props.bodyColumns

    // the terminal draws no Svg: there the picture's words stand in for it
    const drawsPicture = e.surface !== 'terminal' && 'Svg' in table && Boolean(st.svg)
    // In its interactive frame: the desktop runs a picture's motion only there (as a plain image
    // it stands still). The frame takes its size outright (else it is 150 px tall), and it is
    // laid out no wider than the pane (pictureWidth), since a frame narrowed to fit keeps its
    // height and leaves blank bands around the drawing. Centred, the pane's ground beside it.
    const size = (attr: string, fallback: number) => Math.round(Number(new RegExp(`^<svg[^>]*\\s${attr}="(\\d+(?:\\.\\d+)?)"`).exec(st.svg)?.[1] ?? fallback))
    const pictureEl =
      drawsPicture && 'Svg' in table ? (
        <Box flexDirection="column" alignItems="center">
          <table.Svg key={`picture-${st.look}${st.white ? '-white' : ''}`} source={st.svg} alt={st.alt} width={size('width', SIDEBAR_W)} height={size('height', st.height)} isInteractive />
        </Box>
      ) : (
        <Text color={st.gate ? 'warning' : undefined}>{st.alt || 'No workflow.'}</Text>
      )

    // No text boxes: the pane sits beside the chat, and what you would type here (a workflow
    // to start, a note to steer, a change to a review) is said there.

    // Where the picture draws, the whole pane is in the look: one card filling the pane, its
    // ground and edge the look's, the picture bare on it, and around it the controls in the
    // look's colours (words, and buttons drawn as coloured words). The app keeps a thin margin
    // of its own around the card: what a plugin draws is clipped to the pane's inner box.
    if (drawsPicture) {
      const th = paneTheme(st.look, st.white)
      const style = { mono: th.mono, italic: th.italic }
      const say = (text: string) => (th.mono ? text.toLowerCase() : text)
      const words = (text: string, colour: string = th.dim, wrap: 'wrap' | 'truncate-end' = 'wrap') => (
        <Text color={colour} size="footnote" wrap={wrap} {...style}>
          {text}
        </Text>
      )
      const press = (key: string, label: string, text: string, colour: string, onPress: () => unknown, strong = true) => (
        <Button key={key} label={label} plain onPress={async () => onPress()}>
          <Text color={colour} weight={strong ? 'semibold' : undefined} {...style}>
            {text}
          </Text>
        </Button>
      )
      const pause = (key: string) =>
        press(key, st.paused ? 'Resume' : 'Pause', `${st.paused ? '▶' : '‖'} ${say(st.paused ? 'Resume' : 'Pause')}`, th.warn, () => setPause($))

      let parts = null
      if (st.gate) {
        const noAuto = st.gate.noAuto
        parts = (
          <Box flexDirection="column" gap="xs">
            {words(noAuto ? 'This one waits for your yes.' : st.paused ? 'Paused: it waits for you.' : 'With no answer it carries on when the time runs out. Ask for changes in the chat.')}
            <Box flexDirection="row" gap="xs" flexWrap="wrap">
              {press('gate-approve', noAuto ? 'Yes' : 'Approve', `✓ ${say(noAuto ? 'Yes' : 'Approve')}`, th.ok, () => answer($, 'approve'))}
              {noAuto ? null : pause('gate-pause')}
              {press('gate-decline', noAuto ? 'Not now' : 'Decline', `✗ ${say(noAuto ? 'Not now' : 'Decline')}`, th.bad, () => answer($, 'decline'))}
            </Box>
          </Box>
        )
      } else if (st.live) {
        parts = (
          <Box flexDirection="column" gap="xs">
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="xs">
              {words(st.paused ? 'Paused: Claude waits at its next step.' : 'Running. To steer it, tell Claude in the chat.')}
              {pause('flow-pause')}
            </Box>
            {st.notes.waiting > 0 ? words(`◐ ${st.notes.waiting === 1 ? 'Your note waits' : `${st.notes.waiting} notes wait`} for Claude's next step`, th.warn) : null}
            {st.notes.waiting === 0 && st.notes.readAt !== null ? words('✓ Claude read your note', th.ok) : null}
          </Box>
        )
      }

      return (
        <Box
          flexDirection="column"
          backgroundColor={th.ground}
          borderStyle="round"
          borderColor={st.gate ? th.waitingEdge : th.edge}
          padding={0}
          minHeight={e.props.scroll.bodyRows}
        >
          {pictureEl}
          <Box flexDirection="column" gap="xs" paddingX="lg" paddingBottom="md">
            {st.claude?.busy && st.claude.detail ? words(`Claude now: ${st.claude.detail}`, th.dim, 'truncate-end') : null}
            {parts}
            {st.notice ? words(st.notice) : null}
            <Box flexDirection="row" gap="xs" flexWrap="wrap" justifyContent="flex-end">
              {press('open-app', 'Open app', say('Open app ↗'), th.dim, () => openApp($, root, cwd), false)}
              {press('open-console', 'Console', say('Console'), th.dim, () => openConsole($), false)}
            </Box>
            {await runsSection($, { Box, Button, Markdown, Text }, th)}
          </Box>
        </Box>
      )
    }

    // what Claude does right now, in words (the picture moves; this names it)
    const claudeNow = st.claude?.busy && st.claude.detail ? <Text dimColor wrap="truncate-end">{`Claude now: ${st.claude.detail}`}</Text> : null

    let controls
    if (st.gate) {
      controls = (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="semibold" color="warning">{`Your turn: ${st.gate.title}`}</Text>
          <Text dimColor>
            {st.gate.noAuto
              ? 'This one waits for your yes.'
              : st.paused
                ? 'Paused: it waits for you.'
                : 'Approve, pause or decline here, or ask for a change in the chat. With no answer it carries on by itself when the time runs out.'}
          </Text>
          <Box flexDirection="row" marginTop={1}>
            <Button key="gate-approve" label={st.gate.noAuto ? 'Yes' : 'Approve'} onPress={() => answer($, 'approve')} />
            {!st.gate.noAuto && <Button key="gate-pause" label={st.paused ? 'Resume' : 'Pause'} onPress={() => setPause($)} />}
            <Button key="gate-decline" label={st.gate.noAuto ? 'Not now' : 'Decline'} onPress={() => answer($, 'decline')} />
          </Box>
        </Box>
      )
    } else if (st.live) {
      controls = (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>{st.paused ? 'Paused: Claude waits at its next step.' : 'Running. To steer it, tell Claude in the chat.'}</Text>
            <Button key="flow-pause" label={st.paused ? 'Resume' : 'Pause'} onPress={() => setPause($)} />
          </Box>
          {st.notes.waiting > 0 && <Text color="suggestion">{`◐ ${st.notes.waiting === 1 ? 'Your note waits' : `${st.notes.waiting} notes wait`} for Claude's next step`}</Text>}
          {st.notes.waiting === 0 && st.notes.readAt !== null && <Text color="success">✓ Claude read your note</Text>}
        </Box>
      )
    } else {
      controls = (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="semibold">{st.finished ? 'The workflow finished.' : 'No workflow is running here.'}</Text>
          <Text dimColor>
            Start one in the chat: say what it should do. Claude sizes it, plans it (with a second plan from Gemini for big work), builds with Codex, and stops at a review for you. Each step shows here and in the Bridge app.
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {pictureEl}
        {claudeNow}
        {controls}
        {st.notice && <Text dimColor>{st.notice}</Text>}
        <Box flexDirection="row" gap="sm" marginTop={1}>
          <Button key="open-app" label="Open app" onPress={() => openApp($, root, cwd)} />
          <Button key="open-console" label="Console" onPress={() => openConsole($)} />
        </Box>
        {await runsSection($, { Box, Button, Markdown, Text })}
      </Box>
    )
  })
}
