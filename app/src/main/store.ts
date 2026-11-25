import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  currentStage, logEntry, logItems, PROJECT_DIR, projectGoal, projectSection, projectSize, projectTemplate, type Size, withSize, withStage,
} from '../../../core/console'
import { clip, effortsText, logTail, parseEfforts, toJob } from '../../../core/jobs'
import type {
  AppendLog, ListRuns, ReadEfforts, ReadProject, ReadRun, SetStage, StartProject, WriteEffort, WriteHandoff,
} from './contracts'

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function createOnce(path: string, text: string, flag: 'wx' | 'ax'): Promise<boolean> {
  try {
    await writeFile(path, text, { flag })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

async function writeAtomically(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, text, { flag: 'wx' })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

export const readProject: ReadProject = async workdir => {
  const folder = join(workdir, PROJECT_DIR)
  const [project, log] = await Promise.all([
    readIfPresent(join(folder, 'project.md')),
    readIfPresent(join(folder, 'log.md')),
  ])
  const text = project ?? ''
  return {
    exists: project !== null,
    goal: projectGoal(text),
    stage: currentStage(text),
    size: projectSize(text),
    decisions: projectSection(text, 'Decisions'),
    questions: projectSection(text, 'Open questions'),
    log: logItems(log ?? '', 40),
  }
}

export const startProject: StartProject = async (workdir, goal, date, size = 'large') => {
  const folder = join(workdir, PROJECT_DIR)
  await mkdir(folder, { recursive: true })
  await createOnce(join(folder, 'log.md'), '# Shared log\n', 'ax')
  const created = await createOnce(join(folder, 'project.md'), projectTemplate(goal, date, size), 'wx')
  return created ? 'created' : 'exists'
}

export const setStage: SetStage = async (workdir, stageId) => {
  const file = join(workdir, PROJECT_DIR, 'project.md')
  await writeAtomically(file, withStage(await readFile(file, 'utf8'), stageId))
}

/** Sets ## Size in project.md (withSize moves a stage the size lacks); throws if there is no project. */
export async function setSize(workdir: string, size: Size): Promise<void> {
  const file = join(workdir, PROJECT_DIR, 'project.md')
  await writeAtomically(file, withSize(await readFile(file, 'utf8'), size))
}

export const appendLog: AppendLog = async (workdir, who, text, date) => {
  const folder = join(workdir, PROJECT_DIR)
  await mkdir(folder, { recursive: true })
  await appendFile(join(folder, 'log.md'), logEntry(date, who, text))
}

export const readEfforts: ReadEfforts = async paths => parseEfforts(await readIfPresent(paths.settingsFile) ?? '')

const effortWrites = new Map<string, ReturnType<WriteEffort>>()

export const writeEffort: WriteEffort = async (paths, provider, effort) => {
  const file = resolve(paths.settingsFile)
  const previous = effortWrites.get(file)
  const write = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    const next = { ...await readEfforts(paths), [provider]: effort }
    await writeAtomically(file, effortsText(next))
    return next
  })
  effortWrites.set(file, write)
  try {
    return await write
  } finally {
    if (effortWrites.get(file) === write) effortWrites.delete(file)
  }
}

async function readJob(folder: string, id: string, nowSeconds: number) {
  const status = await readIfPresent(join(folder, id, 'status.json'))
  // JSON null is valid JSON but cannot be a status object.
  return status === null || status.trim() === 'null' ? null : toJob(id, status, nowSeconds)
}

export const listRuns: ListRuns = async (paths, nowSeconds, limit) => {
  if (limit <= 0) return []
  const entries = await readdir(paths.runsDir, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  // Run IDs from the scripts start with a sortable local timestamp.
  const ids = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse()
  const jobs = []
  for (const id of ids) {
    const job = await readJob(paths.runsDir, id, nowSeconds)
    if (job) jobs.push(job)
    if (jobs.length >= limit) break
  }
  return jobs
}

export const readRun: ReadRun = async (paths, id) => {
  if (!id || id === '.' || id === '..' || /[\\/:]/.test(id)) throw new Error('Invalid run ID')
  const folder = join(paths.runsDir, id)
  const [brief, reply, job] = await Promise.all([
    readIfPresent(join(folder, 'brief.md')),
    readIfPresent(join(folder, 'result.md')),
    readJob(paths.runsDir, id, Math.floor(Date.now() / 1000)),
  ])
  const log = job?.state === 'failed' ? await readIfPresent(join(folder, 'log.txt')) : ''
  return { brief: clip(brief ?? ''), reply: clip(reply ?? ''), logTail: logTail(log ?? '') }
}

export const writeHandoff: WriteHandoff = async (paths, handoff) => {
  const id = `${Date.now()}-${randomUUID()}`
  const file = join(paths.inboxDir, `${id}.json`)
  const { cwd, mode, text } = handoff
  await mkdir(paths.inboxDir, { recursive: true })
  await writeAtomically(file, `${JSON.stringify({ id, cwd, mode, text })}\n`)
  return file
}
