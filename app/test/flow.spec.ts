import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { answerGate, flowFile, flowPayload, isLive, isPaused, listFlows, readFlow, safeId, setPaused, steerClaude, steerStep } from '../src/main/flow'

async function project(t: TestContext, lines: object[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-flow-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, '.bridge'), { recursive: true })
  if (lines.length) await writeFile(flowFile(dir), lines.map(one => JSON.stringify(one)).join('\n') + '\n')
  return dir
}

const now = () => Date.now() / 1000

test('a folder without a flow gives an empty payload', async t => {
  const dir = await project(t)
  assert.deepEqual(await flowPayload(dir, null), { flow: null, events: [], paused: false, flows: [] })
  assert.deepEqual(await flowPayload(null, null), { flow: null, events: [], paused: false, flows: [] })
})

test('the newest flow is shown unless another is picked, and bad lines are skipped', async t => {
  const t0 = now() - 100
  const dir = await project(t, [
    { t: t0, kind: 'flow', flow: 'f1', title: 'first', size: 'small' },
    { t: t0 + 1, flow: 'f1', id: 'a', lane: 'claude', state: 'done', title: 'did it' },
    { t: t0 + 2, kind: 'flow', flow: 'f2', title: 'second', size: 'large' },
    { t: t0 + 3, flow: 'f2', id: 'b', lane: 'codex', state: 'running', title: 'building' },
  ])
  await writeFile(flowFile(dir), (await readFile(flowFile(dir), 'utf8')) + 'not json\n{"t":"soon"}\n')
  const newest = await flowPayload(dir, null)
  assert.equal(newest.flow?.id, 'f2')
  assert.equal(newest.flow?.size, 'large')
  assert.deepEqual(newest.events.map(e => e.id ?? e.kind), ['flow', 'b'])
  assert.deepEqual(newest.flows.map(f => f.id), ['f1', 'f2'])
  const picked = await flowPayload(dir, 'f1')
  assert.equal(picked.flow?.title, 'first')
  assert.deepEqual(picked.events.map(e => e.id ?? e.kind), ['flow', 'a'])
  assert.equal((await readFlow(dir)).length, 4)
})

test('a flow that ended is marked done', () => {
  const flows = listFlows([
    { t: 1, kind: 'flow', flow: 'f1', title: 'one' },
    { t: 2, kind: 'flow', flow: 'f1', state: 'done' },
  ])
  assert.equal(flows[0]?.state, 'done')
})

test('the first answer to a gate wins; a later one is told it was taken', async t => {
  const dir = await project(t)
  assert.deepEqual(await answerGate(dir, 'f1', 'g1', 'approve'), { ok: true })
  assert.deepEqual(await answerGate(dir, 'f1', 'g1', 'decline'), { taken: true })
  const written = JSON.parse(await readFile(join(dir, '.bridge', 'control', 'gate-g1.json'), 'utf8'))
  assert.equal(written.answer, 'approve')
  // flow.sh carrying on by itself creates the same file first: the click is then too late
  await writeFile(join(dir, '.bridge', 'control', 'gate-g2.json'), JSON.stringify({ answer: 'approve', auto: true }), { flag: 'wx' })
  assert.deepEqual(await answerGate(dir, 'f1', 'g2', 'steer', 'smaller'), { taken: true })
  const events = await readFlow(dir)
  assert.deepEqual(events.map(e => [e.answer, e.gate]), [['approve', 'g1']])
})

test('a steer answer carries its words', async t => {
  const dir = await project(t)
  await answerGate(dir, null, 'g3', 'steer', 'keep it to one file')
  const [event] = await readFlow(dir)
  assert.equal(event?.answer, 'steer')
  assert.equal(event?.text, 'keep it to one file')
})

test('ids from the window are checked before they become file names', () => {
  assert.equal(safeId('gate-1.a_b'), 'gate-1.a_b')
  for (const bad of ['../x', '.hidden', 'a/b', '', 'x'.repeat(81), 5]) assert.throws(() => safeId(bad))
})

test('pause is a file while it lasts, and both changes are in the flow', async t => {
  const dir = await project(t)
  await setPaused(dir, true, 'f1')
  assert.equal(await isPaused(dir), true)
  await setPaused(dir, false, 'f1')
  assert.equal(await isPaused(dir), false)
  assert.deepEqual((await readFlow(dir)).map(e => e.answer), ['pause', 'resume'])
})

test('a steer for Claude waits in the control folder and shows as a you-lane note', async t => {
  const dir = await project(t)
  await steerClaude(dir, 'f1', 'use the smaller layout')
  const files = (await readdir(join(dir, '.bridge', 'control'))).filter(name => name.startsWith('steer-'))
  assert.equal(files.length, 1)
  assert.equal(JSON.parse(await readFile(join(dir, '.bridge', 'control', files[0]!), 'utf8')).text, 'use the smaller layout')
  const [note] = await readFlow(dir)
  assert.equal(note?.kind, 'steer')
  assert.equal(note?.lane, 'you')
  assert.equal(note?.to, 'claude')
  assert.equal(note?.summary, 'use the smaller layout')
  const id = await steerStep(dir, 'f1', 'codex', 'check the tests')
  assert.match(id, /^steer-/)
  await stat(flowFile(dir))
})

test('a flow is live while something runs or waits, or for ten minutes after its last event', () => {
  const t = now()
  const base = { flow: { id: 'f', title: 'x', size: null, t: t - 1000, state: null }, paused: false, flows: [] }
  assert.equal(isLive({ ...base, events: [{ t: t - 900, flow: 'f', id: 'a', lane: 'claude', state: 'running' }] }, t), true)
  assert.equal(isLive({ ...base, events: [{ t: t - 900, flow: 'f', id: 'a', lane: 'claude', state: 'done' }] }, t), false)
  assert.equal(isLive({ ...base, events: [{ t: t - 60, flow: 'f', id: 'a', lane: 'claude', state: 'done' }] }, t), true)
  assert.equal(isLive({ ...base, flow: { ...base.flow, state: 'done' }, events: [{ t: t - 1, flow: 'f', id: 'a', lane: 'claude', state: 'running' }] }, t), false)
})
