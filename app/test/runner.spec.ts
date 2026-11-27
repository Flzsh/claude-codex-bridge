import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { RunRequest } from '../src/main/contracts'
import { pluginPaths } from '../src/main/paths'
import { startRun } from '../src/main/runner'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bridge runner '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = pluginPaths(root)
  await mkdir(paths.scriptsDir, { recursive: true })
  const request: RunRequest = {
    provider: 'codex', prompt: 'Write a reply.\nSecond line.', workdir: root,
    model: 'requested-model', mode: 'read-only', session: 'previous-session',
  }
  let bash = process.env.BRIDGE_BASH ?? 'bash'
  if (process.platform === 'win32' && !process.env.BRIDGE_BASH) {
    for (const candidate of ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe']) {
      if (await access(candidate).then(() => true, () => false)) {
        bash = candidate
        break
      }
    }
  }
  return { root, request, deps: { paths, bash } }
}

test('runner parses stdout, keeps warnings separate, and deletes the brief', { timeout: 10000 }, async t => {
  const { request, deps } = await fixture(t)
  await writeFile(join(deps.paths.scriptsDir, 'pyr.sh'), [
    'set -eu',
    '[[ -d "$1" && -f "$2" && $3 == read-only ]]',
    String.raw`[[ "$0$1$2" != *\\* ]]`,
    '[[ $CODEX_BRIDGE_MODEL == requested-model && $CODEX_BRIDGE_RESUME == previous-session ]]',
    '[[ "$(cat "$2")" == $\'Write a reply. Second line.\n\nWrite a reply.\nSecond line.\' ]]',
    'printf "model=wrong effort=wrong exit=9 time=9s session=wrong\\nwarning\\n" >&2',
    'printf "model=m effort=e exit=0 time=1s run=x session=abc\\nA reply.\\n"',
  ].join('\n') + '\n')
  const run = startRun(request, deps)
  assert.deepEqual(await run.done, {
    ok: true, stopped: false, exitCode: 0, model: 'm', effort: 'e', seconds: 1,
    session: 'abc', reply: 'A reply.',
    stderr: 'model=wrong effort=wrong exit=9 time=9s session=wrong\nwarning\n',
  })
  await run.stop()
  assert.deepEqual(await readdir(deps.paths.briefsDir), [])
})

test('concurrent Gemini runs use separate briefs and the requested conversation', { timeout: 10000 }, async t => {
  const { request, deps } = await fixture(t)
  await writeFile(join(deps.paths.scriptsDir, 'agy.sh'), [
    'set -eu',
    '[[ $AGY_CONVERSATION == previous-session ]]',
    'printf "model=g effort=e exit=0 time=1s run=x\\n"',
    'printf "%s\\n" "$2"',
    'cat "$2"',
  ].join('\n') + '\n')
  const first = startRun({ ...request, provider: 'gemini', prompt: 'First' }, deps)
  const second = startRun({ ...request, provider: 'gemini', prompt: 'Second' }, deps)
  const [a, b] = await Promise.all([first.done, second.done])
  assert.notEqual(first.id, second.id)
  assert.equal(a.ok, true, a.stderr)
  assert.equal(b.ok, true, b.stderr)
  assert.notEqual(a.reply.split('\n')[0], b.reply.split('\n')[0])
  assert.match(a.reply, /\nFirst\n\nFirst$/)
  assert.match(b.reply, /\nSecond\n\nSecond$/)
  assert.deepEqual(await readdir(deps.paths.briefsDir), [])
})

test('stop waits for a sleeping child to exit and removes the brief', { timeout: 12000 }, async t => {
  const { root, request, deps } = await fixture(t)
  const marker = join(root, 'child.pid')
  await writeFile(join(deps.paths.scriptsDir, 'pyr.sh'), [
    'sleep 30 &',
    'child=$!',
    'trap \'wait "$child"; exit 143\' TERM',
    process.platform === 'win32' ? 'cat "/proc/$child/winpid" > "$1/child.pid"' : 'printf "%s\\n" "$child" > "$1/child.pid"',
    'wait "$child"',
  ].join('\n') + '\n')
  const run = startRun(request, deps)
  t.after(() => run.stop())
  let pid = 0
  const deadline = Date.now() + 5000
  while (!pid && Date.now() < deadline) {
    const contents = await readFile(marker, 'utf8').catch(() => '')
    if (/^\d+\r?\n$/.test(contents)) pid = Number(contents)
    else await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(pid > 0, 'fake script reported the sleep process PID')
  assert.doesNotThrow(() => process.kill(pid, 0))
  assert.equal((await readdir(deps.paths.briefsDir)).length, 1)
  await Promise.all([run.stop(), run.stop()])
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  const result = await run.done
  assert.equal(result.stopped, true)
  assert.equal(result.ok, false)
  assert.deepEqual(await readdir(deps.paths.briefsDir), [])
})

test('startup failure resolves with an error and removes the brief', async t => {
  const { root, request, deps } = await fixture(t)
  const run = startRun(request, { ...deps, bash: join(root, 'missing-bash') })
  const result = await run.done
  assert.equal(result.ok, false)
  assert.equal(result.stopped, false)
  assert.equal(result.exitCode, null)
  assert.match(result.stderr, /ENOENT/)
  assert.deepEqual(await readdir(deps.paths.briefsDir), [])
})

test('stop during brief setup prevents the process from starting', async t => {
  const { request, deps } = await fixture(t)
  const run = startRun(request, deps)
  await run.stop()
  const result = await run.done
  assert.equal(result.stopped, true)
  assert.equal(result.exitCode, null)
  assert.deepEqual(await readdir(deps.paths.briefsDir), [])
})
