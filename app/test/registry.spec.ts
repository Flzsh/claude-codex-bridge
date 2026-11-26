import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { test, type TestContext } from 'node:test'

import { deckOrder, readRegistry, sweepRegistry, tabOrder, type Workflow } from '../src/main/registry'

const now = 1_800_000_000.75
const minute = 60
const day = 24 * 60 * minute
const gate = { id: 'review', title: 'Review changes', until: null, noAuto: false }

function workflow(flow: string, fields: Partial<Omit<Workflow, 'flow'>> = {}): Workflow {
  return {
    flow, workdir: '', title: 'Build Bridge', size: 'small', t0: now - 20 * minute,
    t: now - 0.5, state: 'live', gate: null, paused: false, quiet: false, ...fields,
  }
}

function entry(flow: string, workdir: string, fields: Partial<Omit<Workflow, 'flow' | 'workdir' | 'quiet'>> = {}) {
  const { quiet: _quiet, ...record } = workflow(flow, { workdir, ...fields })
  return { v: 1, ...record }
}

function writeEntry(dir: string, record: { flow: string } & Record<string, unknown>, name = `${record.flow}.json`) {
  return writeFile(join(dir, name), JSON.stringify(record))
}

async function setup(t: TestContext) {
  const scratch = await mkdtemp(join(tmpdir(), 'bridge-registry-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const root = await realpath(scratch)
  const dir = join(root, 'registry')
  const workdir = join(root, 'project')
  const log = join(workdir, '.bridge', 'flow.jsonl')
  await mkdir(dir)
  await mkdir(join(workdir, '.bridge'), { recursive: true })
  await writeFile(log, '')
  return { root, dir, workdir, log }
}

async function link(t: TestContext, target: string, path: string, type: 'file' | 'dir') {
  try {
    await symlink(target, path, type === 'dir' && process.platform === 'win32' ? 'junction' : type)
    return true
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (!['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) throw error
    t.skip(`Cannot create ${type} link (${code})`)
    return false
  }
}

test('the registry reads a valid entry and ignores invalid files', async t => {
  const { root, dir, workdir } = await setup(t)
  const fields = { gate: { ...gate, until: now + 15.5 }, paused: true }
  const relativePath = relative(process.cwd(), workdir)
  const missingLog = join(root, 'missing-log')
  await mkdir(join(missingLog, '.bridge'), { recursive: true })
  await writeEntry(dir, entry('valid', workdir, fields))
  await writeFile(join(dir, 'bad-json.json'), '{')
  await writeEntry(dir, { ...entry('bad-version', workdir), v: 2 })
  await writeEntry(dir, entry('bad id', workdir))
  await writeEntry(dir, entry('relative', isAbsolute(relativePath) ? 'project' : relativePath))
  await writeEntry(dir, { ...entry('no-workdir', workdir), workdir: undefined })
  await writeEntry(dir, entry('missing-workdir', join(root, 'missing-project')))
  await writeEntry(dir, entry('missing-log', missingLog))
  await writeEntry(dir, entry('pending', workdir), 'pending.json.tmp-write')
  await writeEntry(dir, entry('pending', workdir), 'pending.json.tmp-write.json')

  assert.deepEqual(await readRegistry(dir, now), [workflow('valid', { workdir, ...fields })])
})

test('the registry fills in omitted fields', async t => {
  const { dir, workdir } = await setup(t)
  const record = { v: 1, flow: 'minimal', workdir, t0: now - 2.5, t: now - 1.25, state: 'live' }
  await writeEntry(dir, record)
  assert.deepEqual(await readRegistry(dir, now), [{
    flow: record.flow, workdir, title: 'workflow', size: null, t0: record.t0, t: record.t,
    state: 'live', gate: null, paused: false, quiet: false,
  }])
})

test('the registry returns the real project path', async t => {
  const { root, dir, workdir } = await setup(t)
  const projects = join(root, 'projects')
  const linked = join(root, 'linked-projects')
  const moved = join(projects, 'project')
  await mkdir(projects)
  await rename(workdir, moved)
  if (!await link(t, projects, linked, 'dir')) return
  await writeEntry(dir, entry('real-path', join(linked, 'project')))

  assert.deepEqual(await readRegistry(dir, now), [workflow('real-path', { workdir: moved })])
})

test('only live flows without a gate go quiet after inactivity', async t => {
  const { dir, workdir } = await setup(t)
  const recent = now - 14 * minute
  const stale = now - 16 * minute
  await writeEntry(dir, entry('recent', workdir, { t: recent }))
  await writeEntry(dir, entry('quiet', workdir, { t: stale }))
  await writeEntry(dir, entry('waiting', workdir, { t: stale, gate }))
  await writeEntry(dir, entry('done', workdir, { t: stale, state: 'done' }))

  const quiet = Object.fromEntries((await readRegistry(dir, now)).map(one => [one.flow, one.quiet]))
  assert.deepEqual(quiet, { recent: false, quiet: true, waiting: false, done: false })
})

test('the registry rejects a linked project and the sweep leaves a dangling project link alone', async t => {
  const { root, dir, workdir } = await setup(t)
  const linked = join(root, 'linked-project')
  if (!await link(t, workdir, linked, 'dir')) return
  await writeEntry(dir, entry('linked', linked))
  assert.deepEqual(await readRegistry(dir, now), [])

  await rename(workdir, join(root, 'moved-project'))
  assert.equal(await sweepRegistry(dir, now), 0)
  assert.deepEqual(await readdir(dir), ['linked.json'])
})

test('the registry rejects a linked flow log', async t => {
  const { root, dir, workdir, log } = await setup(t)
  const target = join(root, 'outside-flow.jsonl')
  await rename(log, target)
  if (!await link(t, target, log, 'file')) return
  await writeEntry(dir, entry('linked-log', workdir))
  assert.deepEqual(await readRegistry(dir, now), [])
})

test('the registry and sweep ignore a linked entry even when its target is expired', async t => {
  const { root, dir, workdir } = await setup(t)
  const record = entry('linked', workdir, { state: 'done', t0: now - 2 * day, t: now - day - 0.25 })
  const target = join(root, 'linked.json')
  const linked = join(dir, 'linked.json')
  await writeEntry(root, record)
  if (!await link(t, target, linked, 'file')) return

  assert.deepEqual(await readRegistry(dir, now), [])
  assert.equal(await sweepRegistry(dir, now), 0)
  assert.equal((await lstat(linked)).isSymbolicLink(), true)
  assert.equal(await readFile(target, 'utf8'), JSON.stringify(record))
})

test('the sweep leaves entries under linked directories alone', async t => {
  const { root, dir, workdir } = await setup(t)
  const linked = join(root, 'linked-registry')
  if (!await link(t, dir, linked, 'dir')) return
  await writeEntry(dir, entry('expired', workdir, { t0: now - 9 * day, t: now - 8 * day }))

  assert.deepEqual(await readRegistry(linked, now), [])
  assert.equal(await sweepRegistry(linked, now), 0)
  const parent = join(root, 'status')
  const linkedParent = join(root, 'linked-status')
  const registry = join(parent, 'registry')
  await mkdir(parent)
  await rename(dir, registry)
  if (!await link(t, parent, linkedParent, 'dir')) return
  assert.equal(await sweepRegistry(join(linkedParent, 'registry'), now), 0)
  assert.deepEqual(await readdir(registry), ['expired.json'])
})

test('the sweep removes only expired entries and entries whose project disappeared', async t => {
  const { root, dir, workdir } = await setup(t)
  const active = { t0: now - 8 * day }
  const done = { ...active, state: 'done' as const }
  const missingLog = join(root, 'missing-log')
  await mkdir(missingLog)
  await writeEntry(dir, entry('done-expired', workdir, { ...done, t: now - day - 0.25 }))
  await writeEntry(dir, entry('done-boundary', workdir, { ...done, t: now - day }))
  await writeEntry(dir, entry('done-recent', workdir, { ...done, t: now - day + 0.25 }))
  await writeEntry(dir, entry('live-expired', workdir, { ...active, t: now - 7 * day - 0.25 }))
  await writeEntry(dir, entry('live-boundary', workdir, { ...active, t: now - 7 * day }))
  await writeEntry(dir, entry('live-recent', workdir, { ...active, t: now - 7 * day + 0.25 }))
  await writeEntry(dir, entry('missing-project', join(root, 'missing-project')))
  await writeEntry(dir, entry('missing-log', missingLog))
  await writeEntry(dir, entry('pending', workdir, { ...done, t: now - 2 * day }), 'pending.json.tmp-write')
  await writeFile(join(dir, 'bad-json.json'), '{')

  assert.equal(await sweepRegistry(dir, now), 3)
  assert.deepEqual((await readdir(dir)).sort(), [
    'bad-json.json', 'done-boundary.json', 'done-recent.json', 'live-boundary.json',
    'live-recent.json', 'missing-log.json', 'pending.json.tmp-write',
  ])
  assert.equal(await sweepRegistry(dir, now), 0)
  assert.equal(await sweepRegistry(join(root, 'missing-registry'), now), 0)
})

test('the deck orders active flows by gate deadline and then by last activity', () => {
  const list = [
    workflow('working-old', { t: now - 90 }),
    workflow('manual', { gate: { ...gate, until: now + 3, noAuto: true } }),
    workflow('waiting-later', { gate: { ...gate, until: now + 30 } }),
    workflow('quiet', { quiet: true }),
    workflow('working-new'),
    workflow('waiting-sooner', { t: now - 120, gate: { ...gate, until: now + 10 } }),
    workflow('no-deadline', { gate }),
    workflow('done', { state: 'done', gate }),
  ]
  const names = (pinned: string | null) => deckOrder(list, pinned).map(one => one.flow)
  const ordered = names(null)
  assert.deepEqual(ordered.slice(0, 2), ['waiting-sooner', 'waiting-later'])
  assert.deepEqual(ordered.slice(2, 4).sort(), ['manual', 'no-deadline'])
  assert.deepEqual(ordered.slice(4), ['working-new', 'working-old'])
  assert.deepEqual(names('working-old'), ['working-old', ...ordered.slice(0, -1)])
  assert.deepEqual(names('quiet'), ordered)
  assert.deepEqual(names('done'), ordered)
})

test('tabs sort by start time, keep ties stable, and show closed flows with gates', () => {
  const list = [
    workflow('newest', { t0: now - 10, t: now - 5, state: 'done' }),
    workflow('tied-z', { t0: now - 60, t: now - 10 }),
    workflow('closed', { t0: now - 70 }),
    workflow('gated', { t0: now - 80, gate }),
    workflow('oldest', { t0: now - 100, quiet: true }),
    workflow('tied-a', { t0: now - 60, t: now - 40 }),
  ]
  const closed = new Set(['closed', 'gated'])
  assert.deepEqual(tabOrder(list, closed).map(one => one.flow), ['oldest', 'gated', 'tied-z', 'tied-a', 'newest'])
  assert.deepEqual(tabOrder([...list].reverse(), closed).map(one => one.flow), ['oldest', 'gated', 'tied-a', 'tied-z', 'newest'])
})
