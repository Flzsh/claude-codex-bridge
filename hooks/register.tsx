import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { currentStage, projectSize, stagesFor } from '../core/console'
import { registerConsole, startConsole } from './console-pane'
import { loadEfforts } from './efforts'
import { pollRuns, startRuns } from './runs'
import { openSidebar, pollSidebar, registerSidebar, startSidebar } from './sidebar'
import { describeTool, heartbeat, statusInit, writeStatus } from './status'

// The shared project's stage in this session's folder (.bridge/project.md).
const stage = atom({ plugin: 'codex-bridge', key: 'stage' } as const, null)

// Short enough that a note typed in Bridge while Claude is idle arrives within a breath.
const POLL_MS = 1500

// This session's folder and the plugin's, set at session start.
let cwd = ''
let root = ''
let isPolling = false

/** What Claude is told about Bridge: that the person may be watching, and how to show the work there. */
const BRIDGE_NOTE = `The person can follow your work in the Bridge pane beside the chat and in the Bridge desktop app (codex-bridge plugin). For a medium or large task, or when they ask for a Bridge workflow, write the live flow with flow.sh as the codex-bridge skill describes (start, steps with --phase, gates for their review, end), so they see each step and can approve, pause or steer. A note they leave for you arrives at your next flow.sh step as STEER=<text>: treat it as their own words.`

async function poll($: EngineInterface) {
  if (isPolling) return
  isPolling = true
  try {
    await pollRuns($)
    await pollStage($)
    await pollInbox($)
    await pollSidebar($)
    await heartbeat($)
  } catch {
    // One bad poll (a file mid-write, a reload) is skipped; the next runs shortly.
  } finally {
    isPolling = false
  }
}

/** Keeps the stage in step with .bridge/project.md. */
async function pollStage($: EngineInterface) {
  if (!cwd) return
  let text = ''
  try {
    text = (await $.fs.exists(`${cwd}/.bridge/project.md`)) ? await $.fs.read(`${cwd}/.bridge/project.md`) : ''
  } catch {
    text = ''
  }
  // The step's name as the project's size calls it (small says Do and Check).
  const id = text ? currentStage(text) : null
  const label = id ? (stagesFor(projectSize(text)).find(one => one.id === id)?.label ?? null) : null
  if (label !== (await read($, stage))) await update($, stage, () => label)
}

/**
 * The same folder. On a Windows drive path (C:\...) backslashes are separators
 * and case is ignored; any other path is compared as it is.
 */
const sameFolder = (a: string, b: string) => {
  const norm = (path: string) =>
    /^[A-Za-z]:[\\/]/.test(path) ? path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : path.replace(/\/+$/, '')
  return norm(a) === norm(b)
}

/**
 * Claims a hand-off by creating <name>.json.taken exclusively (Node's "wx" flag),
 * so of two Claude sessions in one folder exactly one wins. The plugin's own file
 * calls can't create exclusively, so Node does it. True when this session won.
 */
async function claim($: EngineInterface, path: string): Promise<boolean> {
  try {
    const { exitCode } = await $.process.run(
      ['node', '-e', 'require("fs").writeFileSync(process.argv[1], String(Date.now()), { flag: "wx" })', `${path}.taken`],
      { timeoutMs: 15_000 },
    )
    return exitCode === 0
  } catch {
    return false
  }
}

/**
 * Hand-offs from the Bridge app: <plugin>/inbox/<name>.json with { cwd, mode, text }.
 * The session in that folder reads one, claims it (exclusive create of
 * <name>.json.taken), then fills Claude's prompt box or sends it. The app removes
 * a hand-off only once it is claimed, and its marker only once the hand-off is gone.
 */
async function pollInbox($: EngineInterface) {
  const inbox = `${root}/inbox`
  if (!root || !cwd || !(await $.fs.exists(inbox))) return
  for (const entry of await $.fs.list(inbox)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const path = `${inbox}/${entry.name}`
    if (await $.fs.exists(`${path}.taken`)) continue
    let handoff: { cwd?: unknown; mode?: unknown; text?: unknown }
    try {
      handoff = JSON.parse(await $.fs.read(path)) as typeof handoff
    } catch {
      continue
    }
    if (typeof handoff.cwd !== 'string' || typeof handoff.text !== 'string' || !sameFolder(handoff.cwd, cwd)) continue
    if (!(await claim($, path))) continue
    if (handoff.mode === 'send') {
      void $.prompt.submit({ text: handoff.text })
    } else {
      await $.prompt.fill({ text: handoff.text, mode: 'append' })
      $.ui.toast('Bridge: the reply is in your prompt box', { timeoutMs: 5000 })
    }
  }
}

export const register: Register = on => {
  registerConsole(on)
  registerSidebar(on)

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    root = $.plugin.root.replace(/[\\/]+$/, '')
    statusInit($.plugin.root, e.cwd)
    // The timer first, so nothing below can keep it from starting.
    $.clock.every(POLL_MS, () => {
      void poll($)
    })
    await startRuns($)
    await loadEfforts($)
    // Another plugin may own /codex already; the pane works without it.
    try {
      await $.command.register({ name: 'codex', description: 'Open the Bridge pane: the workflow, its reviews, and the Codex and Gemini runs' })
    } catch {
      $.ui.log('codex-bridge: /codex is taken by another plugin; /bridge still opens the app', { to: 'debug' })
    }
    await startConsole($, e.cwd)
    await startSidebar($, e.cwd)
    await poll($)

    return next(e)
  })

  // Claude's own status for the Bridge companion and pane: the main loop only, never a subagent's.
  on('turn.start', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId === undefined) void writeStatus($, 'thinking')
    return next(e)
  })
  on('tool.call', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId === undefined) void writeStatus($, 'tool', describeTool(e.tool, e as unknown as Record<string, unknown>))
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId === undefined) void writeStatus($, 'idle')
    return next(e)
  })

  // Claude knows the person may be watching in Bridge, and how to show the work there.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { ...composed, sections: [...composed.sections, { id: 'codex-bridge:bridge', text: BRIDGE_NOTE, scope: 'session' as const }] }
  })

  on('command.run', { command: 'codex' }, async $ => {
    await openSidebar($)
    return { text: 'Bridge pane opened.' }
  })
}
