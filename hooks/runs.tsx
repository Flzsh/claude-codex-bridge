// Codex and Gemini runs, for the Bridge pane: the newest runs of this plugin's
// pyr.sh / agy.sh, and of the older codex-pyramid skill (~/.codex-pyramid/runs).
// Each opens to show the brief sent and the reply. A finish is announced once.

import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface } from 'claude-code'

import type { Job, JobDetail } from '../types'
import { clip, detail, headline, isVisible, logTail, modelName, ordered, providerName, runsDir, timing, toJob } from '../core/jobs'
import type { PaneTheme } from '../core/pane'

export const jobs = atom({ plugin: 'codex-bridge', key: 'jobs' } as const, [])
export const hiddenIds = atom({ plugin: 'codex-bridge', key: 'hiddenIds' } as const, [])
/** Whether the pane's run list is open (it was the band's card). */
export const isCardOpen = atom({ plugin: 'codex-bridge', key: 'isCardOpen' } as const, false)
const expandedIds = atom({ plugin: 'codex-bridge', key: 'expandedIds' } as const, [])
const details = atom({ plugin: 'codex-bridge', key: 'details' } as const, {})

/** $.store key: whether the run list was left open, kept across sessions. */
const OPEN_KEY = 'isCardOpen'
const NEWEST_RUNS = 12
/** Logs bigger than this are not read for a failed task's tail. */
const LOG_READ_LIMIT = 1024 * 1024

const MARK = { running: '◐', done: '✓', failed: '✗', lost: '?' } as const
const COLOR = { running: 'suggestion', done: 'success', failed: 'error', lost: 'warning' } as const

// The run folders, set at session start: this plugin's, then the codex-pyramid skill's.
let folders: string[] = []
/** Which folder each shown run is in. */
const folderOf = new Map<string, string>()
// The last state seen per run, so a finish is announced once. Starts empty
// after a reload; the first poll only records, it announces nothing.
const seen = new Map<string, Job['state']>()
let isFirstPoll = true
let lastWritten = ''
// The newest runs however long ago they ended, for the pane's picture with no workflow.
let newest: Job[] = []

/** The newest Codex and Gemini runs, newest first, finished ones included at any age. */
export function recentRuns(count = 3): Job[] {
  return newest.filter(job => job.state !== 'lost').slice(0, count)
}

/** A file's text, or '' when it is missing, too big or unreadable. */
export async function readText($: EngineInterface, path: string, limit?: number): Promise<string> {
  try {
    if (!(await $.fs.exists(path))) return ''
    if (limit !== undefined && (await $.fs.stat(path)).size > limit) return ''
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

export async function startRuns($: EngineInterface) {
  const home = ((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '').replace(/\\/g, '/').replace(/\/+$/, '')
  folders = [runsDir($.plugin.root), ...(home ? [`${home}/.codex-pyramid/runs`] : [])]
  const wasOpen = (await $.store.get(OPEN_KEY)) === true
  await update($, isCardOpen, () => wasOpen)
}

async function loadDetail($: EngineInterface, job: Job): Promise<JobDetail> {
  const folder = `${folderOf.get(job.id) ?? folders[0]}/${job.id}`
  const brief = clip(await readText($, `${folder}/brief.md`))
  let reply = clip(await readText($, `${folder}/result.md`))
  if (!reply && job.state === 'failed') {
    const tail = logTail(await readText($, `${folder}/log.txt`, LOG_READ_LIMIT))
    reply = tail ? `No reply. Last log lines:\n\n\`\`\`\n${tail}\n\`\`\`` : 'No reply.'
  }
  return { brief, reply }
}

/** Reloads the brief and reply of every opened run that is still shown. */
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

export async function toggleRuns($: EngineInterface) {
  const isOpen = !(await read($, isCardOpen))
  await update($, isCardOpen, () => isOpen)
  await $.store.set(OPEN_KEY, isOpen)
}

/** Reads the newest runs of both folders; announces a run that finished since the last poll. */
export async function pollRuns($: EngineInterface) {
  const now = Math.floor((await $.clock.now()) / 1000)
  const named: { name: string; folder: string }[] = []
  for (const folder of folders) {
    if (!(await $.fs.exists(folder))) continue
    for (const entry of await $.fs.list(folder)) if (entry.kind === 'dir') named.push({ name: entry.name, folder })
  }
  named.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  const found: Job[] = []
  for (const { name, folder } of named.slice(0, NEWEST_RUNS)) {
    const job = toJob(name, await readText($, `${folder}/${name}/status.json`), now)
    if (!job) continue
    folderOf.set(job.id, folder)
    found.push(job)
  }
  for (const job of found) {
    const before = seen.get(job.id)
    if (!isFirstPoll && before === 'running' && job.state !== 'running') {
      const verb = job.state === 'done' ? 'finished' : job.state === 'failed' ? 'failed' : 'was lost'
      $.ui.toast(`${providerName(job.provider)} task ${verb}: ${modelName(job.model)}${job.title ? ` - ${job.title}` : ''}`, { timeoutMs: 8000 })
    }
    seen.set(job.id, job.state)
  }
  isFirstPoll = false
  newest = found
  const shown = found.filter(isVisible)
  const text = JSON.stringify(shown)
  if (text !== lastWritten) {
    lastWritten = text
    await update($, jobs, () => shown)
  }
  await refreshDetails($)
}

type Els = Pick<ElementTable<'desktop'>, 'Box' | 'Button' | 'Markdown' | 'Text'>

/** The run list as the pane shows it: a header that opens it, then each run. */
/** The runs, in the app's own colours, or in the pane's look's when `theme` is given (the
 * Markdown of a brief and a reply then sits on the look's slip where the ground is dark). */
export async function runsSection($: EngineInterface, { Box, Button, Markdown, Text }: Els, theme?: PaneTheme) {
  const isOpen = await read($, isCardOpen)
  const hidden = await read($, hiddenIds)
  const list = ordered((await read($, jobs)).filter(job => !hidden.includes(job.id)))
  // nothing lately: no header saying so (the pane's picture lists the last runs)
  if (!list.length) return null
  const finished = list.filter(job => job.state !== 'running').map(job => job.id)
  const running = list.length - finished.length
  const open = await read($, expandedIds)
  const texts = await read($, details)
  // the look's colours, or the app's
  const style = theme ? { mono: theme.mono, italic: theme.italic } : {}
  const dim = theme ? { color: theme.dim, ...style } : { dimColor: true }
  const ink = theme ? { color: theme.ink, ...style } : {}
  const tone = (state: Job['state']) => (theme ? { running: theme.running, done: theme.ok, failed: theme.bad, lost: theme.warn }[state] : COLOR[state])
  const sheet = theme?.slip
    ? ({ borderStyle: 'round', borderColor: theme.slip, backgroundColor: theme.slip, paddingX: 1 } as const)
    : ({ borderStyle: 'single', borderDimColor: true, paddingX: 1 } as const)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Button key="toggle-runs" plain onPress={() => toggleRuns($)}>
        <Text {...dim}>{isOpen ? '▾ ' : '▸ '}</Text>
        <Text weight="semibold" {...ink}>
          Codex and Gemini runs
        </Text>
        <Text {...(running > 0 ? { color: tone('running'), ...style } : dim)}>
          {running > 0 ? `  ·  ${running} running` : list.length ? `  ·  ${list.length} recent` : '  ·  none lately'}
        </Text>
      </Button>
      {isOpen &&
        list.map(job => {
          const isJobOpen = open.includes(job.id)
          const text = texts[job.id]
          return (
            <Box key={job.id} flexDirection="column">
              <Box justifyContent="space-between">
                <Button key={`job-${job.id}`} plain onPress={() => toggle($, job.id)}>
                  <Text color={tone(job.state)} {...style}>
                    {isJobOpen ? '▾' : '▸'} {MARK[job.state]}
                  </Text>{' '}
                  <Text {...(job.state === 'running' ? ink : dim)}>{headline(job)}</Text>
                </Button>
                <Text {...(job.state === 'running' ? { color: tone('running'), ...style } : dim)}>{timing(job)}</Text>
              </Box>
              <Text {...dim} wrap="truncate-end">
                {'    '}
                {detail(job)}
              </Text>
              {isJobOpen && (
                <Box flexDirection="column" marginLeft={4} marginBottom={1}>
                  <Text {...dim}>Sent to {providerName(job.provider)}</Text>
                  <Box {...sheet}>
                    <Markdown text={text?.brief || 'Loading…'} />
                  </Box>
                  <Text {...dim}>{`${providerName(job.provider)} ${job.state === 'running' ? 'is working…' : job.state === 'done' ? 'replied' : job.state === 'failed' ? 'failed' : 'job was lost'}`}</Text>
                  {job.state !== 'running' && (
                    <Box {...sheet}>
                      <Markdown text={text?.reply || 'Loading…'} />
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      {isOpen && finished.length > 0 && (
        <Box justifyContent="flex-end">
          {theme ? (
            <Button key="hide-finished" label="Hide finished" plain onPress={() => update($, hiddenIds, ids => [...ids, ...finished].slice(-200))}>
              <Text {...dim}>{theme.mono ? 'hide finished' : 'Hide finished'}</Text>
            </Button>
          ) : (
            <Button key="hide-finished" label="Hide finished" onPress={() => update($, hiddenIds, ids => [...ids, ...finished].slice(-200))} />
          )}
        </Box>
      )}
    </Box>
  )
}
