import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { pluginPaths } from '../src/main/paths'
import {
  appendLog, listRuns, readEfforts, readProject, readRun, setStage,
  startProject, writeEffort, writeHandoff,
} from '../src/main/store'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, paths: pluginPaths(root) }
}

test('plugin paths are rooted in the supplied folder', async t => {
  const { root, paths } = await fixture(t)
  assert.deepEqual(paths, {
    pluginRoot: root,
    runsDir: join(root, 'runs'),
    settingsFile: join(root, 'settings.json'),
    inboxDir: join(root, 'inbox'),
    briefsDir: join(root, 'app-briefs'),
    scriptsDir: join(root, 'skills', 'codex-bridge'),
  })
})

test('project creation is exclusive, stage is editable, and log entries only append', async t => {
  const { root } = await fixture(t)
  const folder = join(root, '.bridge')
  const project = join(folder, 'project.md')
  const log = join(folder, 'log.md')
  const date = '2026-11-24'
  assert.deepEqual(await readProject(root), {
    exists: false, goal: null, stage: null, size: 'large', decisions: [], questions: [], log: [],
  })
  await assert.rejects(setStage(root, 'build'), { code: 'ENOENT' })

  const originalLog = '# Existing log\n\n## 2026-11-23 · Gemini\n\nKeep this.\n'
  await mkdir(folder)
  await writeFile(log, originalLog)
  assert.equal(await startProject(root, 'Build Bridge', date), 'created')
  const originalProject = await readFile(project, 'utf8')
  assert.equal(await startProject(root, 'Replace Bridge', date), 'exists')
  assert.equal(await readFile(project, 'utf8'), originalProject)
  assert.equal(await readFile(log, 'utf8'), originalLog)

  await appendLog(root, 'You', 'First note.', date)
  const firstLog = await readFile(log, 'utf8')
  await appendLog(root, 'Codex', 'Second note.', date)
  assert.ok(firstLog.startsWith(originalLog))
  assert.ok((await readFile(log, 'utf8')).startsWith(firstLog))
  await setStage(root, 'build')
  const view = await readProject(root)
  assert.equal(view.goal, 'Build Bridge')
  assert.equal(view.stage, 'build')
  assert.deepEqual(view.decisions, [`${date}: project started.`])
  assert.deepEqual(view.questions, [])
  assert.deepEqual(view.log.map(item => [item.who, item.text]), [
    ['Codex', 'Second note.'], ['You', 'First note.'], ['Gemini', 'Keep this.'],
  ])
})

test('concurrent project starts create one project and initialize the log', async t => {
  const { root } = await fixture(t)
  const outcomes = await Promise.all([
    startProject(root, 'First goal', '2026-11-24'), startProject(root, 'Second goal', '2026-11-24'),
  ])
  assert.deepEqual([...outcomes].sort(), ['created', 'exists'])
  assert.equal((await readProject(root)).goal, outcomes[0] === 'created' ? 'First goal' : 'Second goal')
  assert.equal(await readFile(join(root, '.bridge', 'log.md'), 'utf8'), '# Shared log\n')
})

test('effort writes merge with disk and preserve concurrent picks from the app', async t => {
  const { paths } = await fixture(t)
  assert.deepEqual(await readEfforts(paths), { codex: null, gemini: null })
  await writeFile(paths.settingsFile, '{"geminiEffort":"medium"}\n')
  assert.deepEqual(await writeEffort(paths, 'codex', 'xhigh'), { codex: 'xhigh', gemini: 'medium' })
  await Promise.all([writeEffort(paths, 'codex', null), writeEffort(paths, 'gemini', 'high')])
  assert.deepEqual(await readEfforts(paths), { codex: null, gemini: 'high' })
  assert.equal(await readFile(paths.settingsFile, 'utf8'), '{"geminiEffort":"high"}\n')
})

test('runs list newest first, skip incomplete status files, and expose failed logs', async t => {
  const { paths } = await fixture(t)
  assert.deepEqual(await listRuns(paths, 100, 2), [])
  const old = '20261124-190000-100'
  const recent = '20261124-190100-101'
  const incomplete = '20261124-190200-102'
  for (const id of [old, recent, incomplete]) await mkdir(join(paths.runsDir, id), { recursive: true })
  const done = join(paths.runsDir, old)
  const failed = join(paths.runsDir, recent)
  await writeFile(join(paths.runsDir, incomplete, 'status.json'), 'null')
  await writeFile(join(done, 'status.json'), JSON.stringify({ startedAt: 20, endedAt: 23, state: 'done', exit: 0 }))
  await writeFile(join(failed, 'status.json'), JSON.stringify({
    provider: 'gemini', startedAt: 80, endedAt: 85, state: 'failed', exit: 1,
  }))
  await writeFile(join(failed, 'brief.md'), '  Request\n')
  await writeFile(join(failed, 'log.txt'), 'early\n1\n2\n3\n4\n5\n6\n7\n\nlast\n')
  await writeFile(join(done, 'result.md'), '  Reply\n')
  await writeFile(join(done, 'log.txt'), 'success output')
  const runs = await listRuns(paths, 100, 2)
  assert.deepEqual(runs.map(job => [job.id, job.provider, job.state, job.seconds]), [
    [recent, 'gemini', 'failed', 5], [old, 'codex', 'done', 3],
  ])
  assert.deepEqual((await listRuns(paths, 100, 1)).map(job => job.id), [recent])
  assert.deepEqual(await readRun(paths, recent), {
    brief: 'Request', reply: '', logTail: '1\n2\n3\n4\n5\n6\n7\nlast',
  })
  assert.deepEqual(await readRun(paths, old), { brief: '', reply: 'Reply', logTail: '' })
})

test('handoffs are published as complete JSON with no temporary files', async t => {
  const { root, paths } = await fixture(t)
  const handoff = { cwd: root, mode: 'fill' as const, text: 'One\nTwo' }
  const [first, second] = await Promise.all([writeHandoff(paths, handoff), writeHandoff(paths, handoff)])
  assert.notEqual(first, second)
  assert.match(basename(first), /^\d+-.+\.json$/)
  assert.deepEqual((await readdir(paths.inboxDir)).sort(), [basename(first), basename(second)].sort())
  assert.deepEqual(JSON.parse(await readFile(first, 'utf8')), {
    id: basename(first, '.json'), ...handoff,
  })
})
