import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job, JobDetail } from '../types'
import { clip, detail, headline, isVisible, logTail, modelName, ordered, runsDir, timing, toJob } from './jobs'

const jobs = atom({ plugin: 'codex-bridge', key: 'jobs' } as const, [])
const hiddenIds = atom({ plugin: 'codex-bridge', key: 'hiddenIds' } as const, [])
const isCardOpen = atom({ plugin: 'codex-bridge', key: 'isCardOpen' } as const, false)
const expandedIds = atom({ plugin: 'codex-bridge', key: 'expandedIds' } as const, [])
const details = atom({ plugin: 'codex-bridge', key: 'details' } as const, {})

/** $.store key: whether the card was left expanded, kept across sessions. */
const OPEN_KEY = 'isCardOpen'
const POLL_MS = 3000
const NEWEST_RUNS = 12
/** Logs bigger than this are not read for a failed task's tail. */
const LOG_READ_LIMIT = 1024 * 1024

const MARK = { running: '◐', done: '✓', failed: '✗', lost: '?' } as const
const COLOR = { running: 'suggestion', done: 'success', failed: 'error', lost: 'warning' } as const

// Set at session start from the plugin's own folder, where pyr.sh writes runs.
let runs = ''
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
        $.ui.toast(`Codex task ${verb}: ${modelName(job.model)}${job.title ? ` - ${job.title}` : ''}`, {
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
  } catch {
    // One bad poll (a file mid-write, a reload) is skipped; the next runs in 3s.
  } finally {
    isPolling = false
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
  on('session.start', async ($, e, next) => {
    runs = runsDir($.plugin.root)
    // The timer first, so nothing below can keep it from starting.
    $.clock.every(POLL_MS, () => {
      void poll($)
    })
    const wasOpen = (await $.store.get(OPEN_KEY)) === true
    await update($, isCardOpen, () => wasOpen)
    await $.command.register({ name: 'codex', description: 'Expand or collapse the Codex card' })
    await poll($)

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

    const header = (
      <Box justifyContent="space-between">
        <Button key="toggle-card" plain onPress={() => toggleCard($)}>
          <Text dimColor>{isOpen ? '▾' : '▸'} </Text>
          <Text weight="semibold">Codex</Text>
        </Button>
        <Text color={running > 0 ? COLOR.running : undefined} dimColor={running === 0}>
          {running > 0 ? `${running} running` : 'idle'}
        </Text>
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
            <Text dimColor>No Codex tasks in the last 20 minutes</Text>
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
                  <Text dimColor>Sent to Codex</Text>
                  <Box borderStyle="single" borderDimColor paddingX={1}>
                    <Markdown text={text?.brief || 'Loading…'} />
                  </Box>
                  <Text dimColor>{job.state === 'running' ? 'Codex is working…' : 'Codex replied'}</Text>
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
