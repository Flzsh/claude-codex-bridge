import { constants, type Stats } from 'node:fs'
import { lstat, readdir, readFile, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { flowFile, safeId } from './flow'

export type Workflow = {
  flow: string
  workdir: string
  title: string
  size: string | null
  t0: number
  t: number
  state: 'live' | 'done'
  gate: { id: string; title: string; until: number | null; noAuto: boolean } | null
  paused: boolean
  quiet: boolean
}

const DAY = 24 * 60 * 60
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function isGate(value: unknown): value is NonNullable<Workflow['gate']> {
  return isRecord(value) && typeof value.id === 'string' && typeof value.title === 'string' &&
    (value.until === null || isTime(value.until)) && typeof value.noAuto === 'boolean'
}

async function registryNames(dir: string) {
  try {
    if (!(await lstat(dir)).isDirectory()) return []
    return (await readdir(dir)).filter(name => name.endsWith('.json') && !name.includes('.json.tmp-'))
  } catch {
    return []
  }
}

async function readEntry(file: string) {
  try {
    const info = await lstat(file)
    if (!info.isFile()) return null
    const entry: unknown = JSON.parse(await readFile(file, {
      encoding: 'utf8', flag: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    }))
    if (!isRecord(entry) || entry.v !== 1) return null
    const { workdir, title = 'workflow', size = null, t0, t, state, gate = null, paused = false } = entry
    if (typeof workdir !== 'string' || !isAbsolute(workdir) || workdir.includes('\0')) return null
    if (typeof title !== 'string' || (size !== null && typeof size !== 'string') || typeof paused !== 'boolean') return null
    if (!isTime(t0) || !isTime(t) || (state !== 'live' && state !== 'done')) return null
    if (gate !== null && !isGate(gate)) return null
    const workflow: Omit<Workflow, 'quiet'> = { flow: safeId(entry.flow), workdir, title, size, t0, t, state, gate, paused }
    return { workflow, info }
  } catch {
    return null
  }
}

export async function readRegistry(dir: string, now: number): Promise<Workflow[]> {
  const workflows: Workflow[] = []
  for (const name of await registryNames(dir)) {
    const entry = await readEntry(join(dir, name))
    if (!entry) continue
    const { workflow } = entry
    try {
      if (!(await lstat(workflow.workdir)).isDirectory()) continue
      const workdir = await realpath(workflow.workdir)
      const log = flowFile(workdir)
      if (!(await lstat(dirname(log))).isDirectory() || !(await lstat(log)).isFile()) continue
      const quiet = workflow.state === 'live' && workflow.gate === null && now - workflow.t > 15 * 60
      workflows.push({ ...workflow, workdir, quiet })
    } catch {
      // The project may have moved since the registry was written.
    }
  }
  return workflows
}

async function workdirMissing(workdir: string) {
  try {
    await lstat(workdir)
    return false
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
}

function unchanged(before: Stats, after: Stats) {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.size === after.size
}

async function unlinkedDirectory(dir: string): Promise<boolean> {
  if (!(await lstat(dir)).isDirectory()) return false
  const parent = dirname(dir)
  return parent === dir || unlinkedDirectory(parent)
}

export async function sweepRegistry(dir: string, now: number): Promise<number> {
  const folder = resolve(dir)
  let deleted = 0
  for (const name of await registryNames(folder)) {
    const file = join(folder, name)
    const entry = await readEntry(file)
    if (!entry) continue
    const { workflow, info } = entry
    const maxAge = workflow.state === 'done' ? DAY : 7 * DAY
    const expired = now - workflow.t > maxAge
    if (!expired && !(await workdirMissing(workflow.workdir))) continue
    try {
      // flow.sh may have replaced the entry since we read it.
      if (!(await unlinkedDirectory(folder)) || !unchanged(info, await lstat(file))) continue
      await unlink(file)
      deleted++
    } catch {
      // The entry may already be gone.
    }
  }
  return deleted
}

const deadline = (gate: NonNullable<Workflow['gate']>) => gate.noAuto ? Infinity : gate.until ?? Infinity

export function deckOrder(list: Workflow[], pinned: string | null): Workflow[] {
  const ordered = list.filter(one => one.state === 'live' && !one.quiet)
  ordered.sort((a, b) => {
    if (a.gate && b.gate) {
      const first = deadline(a.gate)
      const second = deadline(b.gate)
      return first === second ? 0 : first - second
    }
    if (a.gate) return -1
    if (b.gate) return 1
    return b.t - a.t
  })
  const pin = ordered.findIndex(one => one.flow === pinned)
  if (pin > 0) ordered.unshift(...ordered.splice(pin, 1))
  return ordered
}

export function tabOrder(list: Workflow[], closed: ReadonlySet<string>): Workflow[] {
  return list.filter(one => !closed.has(one.flow) || one.gate !== null).sort((a, b) => a.t0 - b.t0)
}
