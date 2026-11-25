import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job, JobDetail, Provider } from '../types'
import {
  clip,
  detail,
  EFFORTS,
  headline,
  isVisible,
  logTail,
  modelName,
  ordered,
  providerName,
  runsDir,
  timing,
  toJob,
} from '../core/jobs'
import { currentStage, projectSize, stagesFor } from '../core/console'
import { openConsole, registerConsole, startConsole } from './console-pane'
import { loadEfforts } from './efforts'
import { openApp } from './launch'
import { describeTool, statusInit, writeStatus } from './status'

const jobs = atom({ plugin: 'codex-bridge', key: 'jobs' } as const, [])
const hiddenIds = atom({ plugin: 'codex-bridge', key: 'hiddenIds' } as const, [])
const isCardOpen = atom({ plugin: 'codex-bridge', key: 'isCardOpen' } as const, false)
const expandedIds = atom({ plugin: 'codex-bridge', key: 'expandedIds' } as const, [])
const details = atom({ plugin: 'codex-bridge', key: 'details' } as const, {})
// The shared project's stage in this session's folder (.bridge/project.md), for the band.
const stage = atom({ plugin: 'codex-bridge', key: 'stage' } as const, null)

/** $.store key: whether the card was left expanded, kept across sessions. */
const OPEN_KEY = 'isCardOpen'
// Short enough that a steer typed in Bridge while Claude is idle arrives within a breath.
const POLL_MS = 1500
const NEWEST_RUNS = 12
/** Logs bigger than this are not read for a failed task's tail. */
const LOG_READ_LIMIT = 1024 * 1024

const MARK = { running: '◐', done: '✓', failed: '✗', lost: '?' } as const
const COLOR = { running: 'suggestion', done: 'success', failed: 'error', lost: 'warning' } as const

// Set at session start from the plugin's own folder, where pyr.sh writes runs.
let runs = ''
// This session's folder and the plugin's, set at session start.
let cwd = ''
let root = ''
// The last state seen per run, so a finish is announced once. Starts empty
// after a reload; the first poll only records, it announces nothing.
const seen = new Map<string, Job['state']>()
let isFirstPoll = true
let isPolling = false
let lastWritten = ''

/** A file's text, or '' when it is missing, too big or unreadable. */
async function readText($: EngineInterface, path: string, limit?: number): Promise<string> {
  try {
    if (!(await $.fs.exists(path))) return ''
    if (limit !== undefined && (await $.fs.stat(path)).size > limit) return ''
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

/** The brief and reply of one run, as the card shows them. */
async function loadDetail($: EngineInterface, job: Job): Promise<JobDetail> {
  const folder = `${runs}/${job.id}`
  const brief = clip(await readText($, `${folder}/brief.md`))
  let reply = clip(await readText($, `${folder}/result.md`))
  if (!reply && job.state === 'failed') {
    const tail = logTail(await readText($, `${folder}/log.txt`, LOG_READ_LIMIT))
    reply = tail ? `No reply. Last log lines:\n\n\`\`\`\n${tail}\n\`\`\`` : 'No reply.'
  }
  return { brief, reply }
}

/** Reloads the brief and reply of every expanded task that is still shown. */
async function refreshDetails($: EngineInterface) {
  const open = await read($, expandedIds)
  const shown = (await read($, jobs)).filter(job => open.includes(job.id))
  const next: Record<string, JobDetail> = {}
  for (const job of shown) next[job.id] = await loadDetail($, job)
  if (JSON.stringify(next) !== JSON.stringify(await read($, details))) await update($, details, () => next)
}

async function toggle($: EngineInterface, id: string) {
  await update($, expandedIds, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))
  await refreshDetails($)
}

async function poll($: EngineInterface) {
  if (isPolling || !runs) return
  isPolling = true
  try {
    const now = Math.floor((await $.clock.now()) / 1000)
    const names = (await $.fs.exists(runs))
      ? (await $.fs.list(runs))
          .filter(entry => entry.kind === 'dir')
          .map(entry => entry.name)
          .sort()
          .reverse()
          .slice(0, NEWEST_RUNS)
      : []

    const found: Job[] = []
    for (const name of names) {
      const job = toJob(name, await readText($, `${runs}/${name}/status.json`), now)
      if (job) found.push(job)
    }

    for (const job of found) {
      const before = seen.get(job.id)
      if (!isFirstPoll && before === 'running' && job.state !== 'running') {
        const verb = job.state === 'done' ? 'finished' : job.state === 'failed' ? 'failed' : 'was lost'
        $.ui.toast(`${providerName(job.provider)} task ${verb}: ${modelName(job.model)}${job.title ? ` - ${job.title}` : ''}`, {
          timeoutMs: 8000,
        })
      }
      seen.set(job.id, job.state)
    }
    isFirstPoll = false

    const shown = found.filter(isVisible)
    const text = JSON.stringify(shown)
    if (text !== lastWritten) {
      lastWritten = text
      await update($, jobs, () => shown)
    }

    await refreshDetails($)
    await pollStage($)
    await pollInbox($)
  } catch {
    // One bad poll (a file mid-write, a reload) is skipped; the next runs in 3s.
  } finally {
    isPolling = false
  }
}

/** Keeps the band's stage in step with .bridge/project.md. */
async function pollStage($: EngineInterface) {
  if (!cwd) return
  const text = await readText($, `${cwd}/.bridge/project.md`)
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

async function setCardOpen($: EngineInterface, isOpen: boolean) {
  await update($, isCardOpen, () => isOpen)
  await $.store.set(OPEN_KEY, isOpen)
}

async function toggleCard($: EngineInterface) {
  await setCardOpen($, !(await read($, isCardOpen)))
}

export const register: Register = on => {
  registerConsole(on)

  on('session.start', async ($, e, next) => {
    runs = runsDir($.plugin.root)
    cwd = e.cwd
    root = $.plugin.root.replace(/[\\/]+$/, '')
    statusInit($.plugin.root, e.cwd)
    // The timer first, so nothing below can keep it from starting.
    $.clock.every(POLL_MS, () => {
      void poll($)
    })
    const wasOpen = (await $.store.get(OPEN_KEY)) === true
    await update($, isCardOpen, () => wasOpen)
    await loadEfforts($)
    // Another plugin may own /codex already; the card and the console work without it.
    try {
      await $.command.register({ name: 'codex', description: 'Expand or collapse the Codex card' })
    } catch {
      $.ui.log('codex-bridge: /codex is taken by another plugin; use the card header instead', { to: 'debug' })
    }
    await startConsole($, e.cwd)
    await poll($)

    return next(e)
  })

  // Claude's own status for the Bridge companion: the main loop only, never a subagent's.
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

  on('command.run', { command: 'codex' }, async $ => {
    await toggleCard($)

    return { text: (await read($, isCardOpen)) ? 'Codex card expanded.' : 'Codex card collapsed.' }
  })

  // The Codex card: always shown above the message box. Collapsed it is one
  // line; expanded it lists the tasks, each of which opens to show the brief
  // sent and Codex's reply.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const isOpen = await read($, isCardOpen)
    const hidden = await read($, hiddenIds)
    const list = ordered((await read($, jobs)).filter(job => !hidden.includes(job.id)))
    const finished = list.filter(job => job.state !== 'running').map(job => job.id)
    const running = list.length - finished.length

    const stageLabel = await read($, stage)

    // One line: the mark and name (opens the run list), the project's stage,
    // what is running, and the two ways in: the app, or the console here.
    const header = (
      <Box justifyContent="space-between" alignItems="center">
        <Box alignItems="center">
          <Button key="toggle-card" plain onPress={() => toggleCard($)}>
            <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
            <Text color="claude">◆ </Text>
            <Text weight="semibold">Bridge</Text>
          </Button>
          {stageLabel && <Text dimColor>{`  ·  ${stageLabel}`}</Text>}
          <Text color={running > 0 ? COLOR.running : undefined} dimColor={running === 0}>
            {running > 0 ? `  ·  ${running} running` : '  ·  idle'}
          </Text>
        </Box>
        <Box alignItems="center">
          <Button key="open-app" plain onPress={() => openApp($, root, cwd)}>
            <Text color="claude">Open app</Text>
          </Button>
          <Text dimColor>{'  '}</Text>
          <Button key="open-console" plain onPress={() => openConsole($)}>
            <Text dimColor>Console</Text>
          </Button>
        </Box>
      </Box>
    )

    if (!isOpen) {
      return (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          {header}
        </Box>
      )
    }

    const open = await read($, expandedIds)
    const texts = await read($, details)

    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        {header}
        {list.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>No Codex or Gemini tasks in the last 20 minutes</Text>
          </Box>
        )}
        {list.map((job, index) => {
          const isJobOpen = open.includes(job.id)
          const text = texts[job.id]
          return (
            <Box key={job.id} flexDirection="column" marginTop={index === 0 ? 1 : 0}>
              <Box justifyContent="space-between">
                <Button key={`job-${job.id}`} plain onPress={() => toggle($, job.id)}>
                  <Text color={COLOR[job.state]}>
                    {isJobOpen ? '▾' : '▸'} {MARK[job.state]}
                  </Text>{' '}
                  <Text dimColor={job.state !== 'running'}>{headline(job)}</Text>
                </Button>
                <Text color={job.state === 'running' ? COLOR.running : undefined} dimColor={job.state !== 'running'}>
                  {timing(job)}
                </Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {'    '}
                {detail(job)}
              </Text>
              {isJobOpen && (
                <Box flexDirection="column" marginLeft={4} marginBottom={1}>
                  <Text dimColor>Sent to {providerName(job.provider)}</Text>
                  <Box borderStyle="single" borderDimColor paddingX={1}>
                    <Markdown text={text?.brief || 'Loading…'} />
                  </Box>
                  <Text dimColor>{`${providerName(job.provider)} ${job.state === 'running' ? 'is working…' : job.state === 'done' ? 'replied' : job.state === 'failed' ? 'failed' : 'job was lost'}`}</Text>
                  {job.state !== 'running' && (
                    <Box borderStyle="single" borderDimColor paddingX={1}>
                      <Markdown text={text?.reply || 'Loading…'} />
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
        {finished.length > 0 && (
          <Box justifyContent="flex-end" marginTop={1}>
            <Button
              key="hide-finished"
              label="Hide finished"
              onPress={() => update($, hiddenIds, ids => [...ids, ...finished].slice(-200))}
            />
          </Box>
        )}
      </Box>
    )
  })
}
