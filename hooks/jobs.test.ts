import { describe as group, expect, test } from 'claude-code/testing'

import { clip, detail, duration, headline, isVisible, logTail, modelName, ordered, providerName, runsDir, timing, toJob } from './jobs'

const status = (fields: Record<string, unknown>) =>
  JSON.stringify({
    model: 'gpt-6.1-sol',
    effort: 'ultra',
    title: 'Fix the planner bug',
    workdir: 'canvas-harness',
    startedAt: 1000,
    state: 'running',
    exit: null,
    endedAt: null,
    ...fields,
  })

group('codex jobs', () => {
  test('a running job counts its time up to now', () => {
    const job = toJob('a', status({}), 1134)
    expect(job?.state).toBe('running')
    expect(job?.seconds).toBe(134)
    expect(headline(job!)).toBe('Sol 6.1 · ultra')
    expect(timing(job!)).toBe('running 2m 14s')
    expect(detail(job!)).toBe('Fix the planner bug · canvas-harness')
    expect(isVisible(job!)).toBe(true)
  })

  test('a finished job shows how long it took and stays for twenty minutes', () => {
    const job = toJob('b', status({ state: 'done', exit: 0, endedAt: 1063 }), 1063 + 240)
    expect(job?.seconds).toBe(63)
    expect(timing(job!)).toBe('done in 1m 03s · 4m 00s ago')
    expect(isVisible(job!)).toBe(true)
    expect(isVisible(toJob('b', status({ state: 'done', exit: 0, endedAt: 1063 }), 1063 + 1300)!)).toBe(false)
  })

  test('a failed job names its exit code', () => {
    const job = toJob('c', status({ model: 'gpt-6-astra', effort: 'max', state: 'failed', exit: 1, endedAt: 1030 }), 1040)
    expect(headline(job!)).toBe('Astra 6 · max')
    expect(timing(job!)).toBe('failed (exit 1) after 30s')
  })

  test('a job running for hours without a finish is lost and hidden', () => {
    const job = toJob('d', status({}), 1000 + 4 * 3600)
    expect(job?.state).toBe('lost')
    expect(isVisible(job!)).toBe(false)
  })

  test('unreadable status is skipped', () => {
    expect(toJob('e', '{"model":', 1000)).toBe(null)
    expect(toJob('e', '{}', 1000)).toBe(null)
  })

  test('durations and names read naturally', () => {
    expect(duration(9)).toBe('9s')
    expect(duration(3725)).toBe('1h 02m')
    expect(modelName('o3')).toBe('o3')
    expect(modelName('gpt-6-astra')).toBe('Astra 6')
    expect(modelName('gemini-4-neon')).toBe('Gemini 4 Neon')
    expect(modelName('gemini')).toBe('Gemini')
  })

  test('a run from 0.1.0 has no provider and counts as Codex', () => {
    const job = toJob('f', status({}), 1010)
    expect(job?.provider).toBe('codex')
    expect(providerName(job!.provider)).toBe('Codex')
  })

  test('a Gemini run is named as Gemini', () => {
    const job = toJob('g', status({ provider: 'gemini', model: 'gemini-4-neon', effort: '', state: 'done', exit: 0, endedAt: 1020 }), 1030)
    expect(job?.provider).toBe('gemini')
    expect(providerName(job!.provider)).toBe('Gemini')
    expect(headline(job!)).toBe('Gemini 4 Neon')
  })
})

group('codex jobs order', () => {
  test('running jobs come first', () => {
    const done = toJob('new', status({ state: 'done', exit: 0, endedAt: 1050 }), 1100)!
    const running = toJob('old', status({}), 1100)!
    expect(ordered([done, running]).map(job => job.id)).toEqual(['old', 'new'])
  })
})

group('codex jobs detail text', () => {
  test('long texts are clipped with a pointer to the run folder', () => {
    expect(clip('short')).toBe('short')
    expect(clip('x'.repeat(30), 10)).toBe(`${'x'.repeat(10)}\n\n… 20 more characters in the run folder`)
  })

  test('a log tail keeps the last non-empty lines', () => {
    const log = 'one\n\ntwo\n  \nthree\n'
    expect(logTail(log, 2)).toBe('two\nthree')
  })
})

group('codex jobs runs folder', () => {
  test('runs live in the plugin folder, whatever its trailing slash', () => {
    expect(runsDir('C:\\plugins\\codex-bridge\\')).toBe('C:\\plugins\\codex-bridge/runs')
    expect(runsDir('/home/me/.claude/plugins/codex-bridge')).toBe('/home/me/.claude/plugins/codex-bridge/runs')
  })
})
