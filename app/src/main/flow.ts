// The flow, on the main side: reads <project>/.bridge/flow.jsonl, and writes
// the owner's answers in .bridge/control/<flow>/ (or the flat control folder):
// - a gate's answer is gate-<id>.json, created exclusively,
//   so the first answer wins (a click, or flow.sh carrying on at the end of the wait);
// - pause is pause.json, present while paused;
// - a steer for Claude mid-workflow is steer-<time>-<rand>.json,
//   which Claude's next `flow.sh step` or `check` prints and marks taken.
// Every answer is also appended to flow.jsonl, so the view shows it.

import { randomBytes } from 'node:crypto'
import { appendFile, lstat, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { fold, ofFlow, parseFlow, type FlowEvent } from '../../../core/flow'

export type FlowInfo = { id: string; title: string; size: string | null; t: number; state: string | null }
export type FlowPayload = { flow: FlowInfo | null; events: FlowEvent[]; paused: boolean; flows: FlowInfo[] }

const MAX_READ = 4 * 1024 * 1024

const bridgeDir = (workdir: string) => join(workdir, '.bridge')

/** A link planted in a cloned project must not redirect the app's writes outside it. */
async function refuseLinks(...paths: string[]) {
  for (const path of paths) {
    const info = await lstat(path).catch(() => null)
    if (info?.isSymbolicLink()) throw new Error(`${path} is a link; Bridge does not write through links`)
  }
}
const controlDir = (workdir: string, flow?: string | null) => join(workdir, '.bridge', 'control', flow == null ? '' : safeId(flow))
export const flowFile = (workdir: string) => join(workdir, '.bridge', 'flow.jsonl')

/** A gate or step id from the file: letters, digits, dot, dash, underscore. */
export function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w.-]{1,80}$/.test(value) || value.startsWith('.')) throw new Error('Bad id')
  return value
}

/** Every event in the file (the last 4 MB when it is larger). */
export async function readFlow(workdir: string): Promise<FlowEvent[]> {
  const file = flowFile(workdir)
  let size = 0
  try {
    size = (await stat(file)).size
  } catch {
    return []
  }
  if (size <= MAX_READ) return parseFlow(await readFile(file, 'utf8'))
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(MAX_READ)
    await handle.read(buffer, 0, MAX_READ, size - MAX_READ)
    const text = buffer.toString('utf8')
    // The first line is probably cut: drop it.
    return parseFlow(text.slice(text.indexOf('\n') + 1))
  } finally {
    await handle.close()
  }
}

/** The flows in the file, oldest first, from their start events. */
export function listFlows(events: FlowEvent[]): FlowInfo[] {
  const flows = new Map<string, FlowInfo>()
  for (const e of events) {
    if (e.kind !== 'flow' || !e.flow) continue
    const known = flows.get(e.flow)
    if (!known) flows.set(e.flow, { id: e.flow, title: e.title ?? 'workflow', size: typeof e.size === 'string' ? e.size : null, t: e.t, state: e.state ?? null })
    else if (e.state) known.state = e.state
  }
  return [...flows.values()]
}

export async function isPaused(workdir: string, flow?: string | null): Promise<boolean> {
  if (await stat(join(controlDir(workdir), 'pause.json')).then(() => true, () => false)) return true
  if (flow == null) return false
  try {
    await stat(join(controlDir(workdir, flow), 'pause.json'))
    return true
  } catch {
    return false
  }
}

/** What the window draws: one flow's events (the newest unless another was picked). */
export async function flowPayload(workdir: string | null, shown: string | null): Promise<FlowPayload> {
  if (!workdir) return { flow: null, events: [], paused: false, flows: [] }
  const all = await readFlow(workdir)
  const flows = listFlows(all)
  const flow = flows.find(one => one.id === shown) ?? flows[flows.length - 1] ?? null
  const events = flow ? ofFlow(all, flow.id) : all.filter(e => !e.flow)
  return { flow, events, paused: await isPaused(workdir, flow?.id), flows }
}

async function append(workdir: string, event: Record<string, unknown>) {
  await refuseLinks(workdir, bridgeDir(workdir), flowFile(workdir))
  await mkdir(bridgeDir(workdir), { recursive: true })
  await appendFile(flowFile(workdir), JSON.stringify({ t: Date.now() / 1000, ...event }) + '\n', 'utf8')
}

async function controlFile(workdir: string, flow: string | null, name: string) {
  const dir = controlDir(workdir, flow)
  const file = join(dir, name)
  await refuseLinks(workdir, bridgeDir(workdir), controlDir(workdir), dir, file, flowFile(workdir))
  await mkdir(dir, { recursive: true })
  return file
}

/** The gate's answer, if nobody answered first. */
export async function answerGate(workdir: string, flow: string | null, gate: string, answer: 'approve' | 'decline' | 'steer', text?: string): Promise<{ ok?: boolean; taken?: boolean }> {
  const id = safeId(gate)
  const file = await controlFile(workdir, flow, `gate-${id}.json`)
  const body = JSON.stringify({ answer, text: text ?? null, by: 'you', t: Date.now() / 1000 })
  try {
    await writeFile(file, body, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { taken: true }
    throw error
  }
  await append(workdir, { ...(flow ? { flow } : {}), answer, gate: id, ...(text ? { text: text.slice(0, 2000) } : {}), by: 'you' })
  return { ok: true }
}

export async function setPaused(workdir: string, paused: boolean, flow: string | null) {
  const file = await controlFile(workdir, flow, 'pause.json')
  // wx: an existing pause (or anything planted under that name) is left as it is
  if (paused) {
    const held = await readFile(file, 'utf8').then(text => (JSON.parse(text) as { by?: unknown }).by === 'queue', () => false)
    // a queue hold becomes your pause, so the queue never lifts it
    if (held) await writeFile(file, JSON.stringify({ by: 'you', t: Date.now() / 1000 }))
    else await writeFile(file, JSON.stringify({ by: 'you', t: Date.now() / 1000 }), { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
  }
  else {
    await rm(file, { force: true })
    // a pause left in the flat folder (by an older build) holds every flow: a resume lifts it too
    if (flow) await rm(await controlFile(workdir, null, 'pause.json'), { force: true })
  }
  await append(workdir, { ...(flow ? { flow } : {}), answer: paused ? 'pause' : 'resume', by: 'you' })
}

/**
 * The review queue: when timed reviews wait in several workflows at once, only the one in front
 * of the owner counts down; the others are held by a pause marked as the queue's, and let go when
 * their turn comes (flow.sh then starts their countdown afresh) or their review closes. A pause
 * the owner made is never touched.
 */
export async function queuePause(workdir: string, flow: string, hold: boolean) {
  if (!hold && !(await lstat(join(controlDir(workdir, flow), 'pause.json')).then(() => true, () => false))) return
  const file = await controlFile(workdir, flow, 'pause.json')
  const current = await readFile(file, 'utf8').then(
    text => JSON.parse(text) as { by?: unknown },
    () => null,
  )
  if (hold) {
    if (current === null) await writeFile(file, JSON.stringify({ by: 'queue', t: Date.now() / 1000 }), { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
  } else if (current?.by === 'queue') await rm(file, { force: true })
}

/** Is Claude in the middle of this flow (so a steer waits for its next step, not a new prompt)? */
export function isLive(payload: FlowPayload, now = Date.now() / 1000): boolean {
  if (!payload.flow || payload.flow.state === 'done') return false
  const steps = fold(payload.events, now)
  for (const s of steps.values()) if (s.state === 'running' || s.state === 'waiting') return true
  const last = payload.events[payload.events.length - 1]
  return Boolean(last && now - last.t < 10 * 60)
}

/** A steer for Claude mid-workflow: left for its next flow.sh call, and drawn in the flow now. Returns the note's file. */
export async function steerClaude(workdir: string, flow: string | null, text: string): Promise<string> {
  const name = `steer-${Date.now()}-${randomBytes(4).toString('hex')}.json`
  const file = await controlFile(workdir, flow, name)
  await writeFile(file, JSON.stringify({ text, by: 'you', t: Date.now() / 1000 }), { flag: 'wx' })
  await steerStep(workdir, flow, 'claude', text)
  return file
}

/** The you-lane note that shows a steer, pointing at whoever it went to. */
export async function steerStep(workdir: string, flow: string | null, to: 'claude' | 'codex' | 'gemini', text: string) {
  const id = `steer-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
  await append(workdir, { ...(flow ? { flow } : {}), id, lane: 'you', kind: 'steer', state: 'done', to, title: `steered ${to}`, summary: text.slice(0, 500) })
  return id
}
