import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Threads } from '../src/main/contracts'
import { finish, newThreads, reserve, reset } from '../src/main/threads'

function fixture(): Threads {
  return Object.freeze({
    codex: Object.freeze({ session: 'codex-session', generation: 3, runningId: null }),
    gemini: Object.freeze({ session: 'gemini-session', generation: 7, runningId: 'gemini-run' }),
  })
}

test('newThreads initializes independent, idle threads', () => {
  const threads = newThreads()
  assert.deepEqual(threads, {
    codex: { session: null, generation: 0, runningId: null },
    gemini: { session: null, generation: 0, runningId: null },
  })
  assert.notEqual(threads.codex, threads.gemini)
  assert.notEqual(newThreads().codex, threads.codex)
})

test('reserve claims an idle provider while the other provider is busy', () => {
  const before = fixture()
  const after = reserve(before, 'codex', 'codex-run')
  assert.ok(after)
  assert.deepEqual(after.codex, { session: 'codex-session', generation: 3, runningId: 'codex-run' })
  assert.equal(after.gemini, before.gemini)
})

test('reserve refuses a busy provider', () => {
  assert.equal(reserve(fixture(), 'gemini', 'another-run'), null)
})

test('finish releases the matching run and saves its session in the current generation', () => {
  const before = fixture()
  const after = finish(before, 'gemini', 'gemini-run', 7, 'new-gemini-session')
  assert.deepEqual(after.gemini, { session: 'new-gemini-session', generation: 7, runningId: null })
  assert.equal(after.codex, before.codex)
})

test('finish preserves the existing conversation when no session ID comes back', () => {
  const after = finish(fixture(), 'gemini', 'gemini-run', 7, null)
  assert.deepEqual(after.gemini, { session: 'gemini-session', generation: 7, runningId: null })
})

test('reset starts a new generation while the current run keeps its slot', () => {
  const before = fixture()
  const after = reset(before, 'gemini')
  assert.deepEqual(after.gemini, { session: null, generation: 8, runningId: 'gemini-run' })
  assert.equal(after.codex, before.codex)
  assert.equal(reserve(after, 'gemini', 'another-run'), null)
})

test('a late reply after reset frees its slot without restoring its session', () => {
  const before = reset(fixture(), 'gemini')
  const after = finish(before, 'gemini', 'gemini-run', 7, 'late-gemini-session')
  assert.deepEqual(after.gemini, { session: null, generation: 8, runningId: null })
  assert.equal(reserve(after, 'gemini', 'another-run')?.gemini.runningId, 'another-run')
})

test('finish ignores a run that does not own the slot even in the current generation', () => {
  const before = fixture()
  assert.equal(finish(before, 'gemini', 'older-run', 7, 'wrong-session'), before)
  assert.equal(finish(before, 'codex', 'older-run', 3, 'wrong-session'), before)
})
