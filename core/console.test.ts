import { describe as group, expect, test } from 'claude-code/testing'

import {
  bashPath,
  consoleBrief,
  logEntry,
  NEW_CONSOLE,
  nextId,
  parseCommand,
  parseRunOutput,
  currentStage,
  logItems,
  nextStage,
  projectSize,
  stagesFor,
  withSize,
  projectGoal,
  projectSection,
  projectTemplate,
  shortTitle,
  withEntries,
  withStage,
} from './console'

group('console commands', () => {
  test('plain text is a prompt', () => {
    expect(parseCommand('  fix the bug ')).toEqual({ kind: 'prompt', text: 'fix the bug' })
  })

  test('slash commands', () => {
    expect(parseCommand('/new')).toEqual({ kind: 'new' })
    expect(parseCommand('/Gemini')).toEqual({ kind: 'provider', provider: 'gemini' })
    expect(parseCommand('/model gpt-6.2-astra')).toEqual({ kind: 'model', model: 'gpt-6.2-astra' })
    expect(parseCommand('/effort XHIGH')).toEqual({ kind: 'effort', level: 'xhigh' })
    expect(parseCommand('/effort default')).toEqual({ kind: 'effort', level: null })
    expect(parseCommand('/mode write')).toEqual({ kind: 'mode', mode: 'workspace-write' })
    expect(parseCommand('/mode read-only')).toEqual({ kind: 'mode', mode: 'read-only' })
    expect(parseCommand('/project')).toEqual({ kind: 'project', goal: null })
    expect(parseCommand('/project start Ship the planner')).toEqual({ kind: 'project', goal: 'Ship the planner' })
    expect(parseCommand('/note the API is v2 now')).toEqual({ kind: 'note', text: 'the API is v2 now' })
    expect(parseCommand('/claude')).toEqual({ kind: 'claude', text: '' })
    expect(parseCommand('/claude check this')).toEqual({ kind: 'claude', text: 'check this' })
  })

  test('unknown or incomplete commands are reported, not sent', () => {
    expect(parseCommand('/mode fast').kind).toBe('unknown')
    expect(parseCommand('/model').kind).toBe('unknown')
    expect(parseCommand('/frobnicate').kind).toBe('unknown')
    expect(parseCommand('/project open').kind).toBe('unknown')
    expect(parseCommand('/note').kind).toBe('unknown')
  })
})

group('console run output', () => {
  test('reads the status line and the reply', () => {
    const out = parseRunOutput(
      'model=gpt-6.2-sol effort=high exit=0 time=7s run=/c/x/runs/1 session=01a2-b3\r\nline one\nline two\n',
    )
    expect(out).toEqual({
      model: 'gpt-6.2-sol',
      effort: 'high',
      exit: 0,
      seconds: 7,
      session: '01a2-b3',
      reply: 'line one\nline two',
    })
  })

  test('an empty effort and session read as empty and null', () => {
    const out = parseRunOutput('model=gemini effort= exit=1 time=3s run=/r session=\nNO RESULT.')
    expect(out.effort).toBe('')
    expect(out.session).toBe(null)
    expect(out.exit).toBe(1)
  })

  test('output without a status line is kept whole as the reply', () => {
    expect(parseRunOutput('agy not found.\n').reply).toBe('agy not found.')
  })
})

group('console helpers', () => {
  test('the brief starts with a short title for the card', () => {
    expect(consoleBrief('  explain\n  this file  ')).toBe('explain this file\n\nexplain\n  this file\n')
  })

  test('a long prompt is titled up to a word, with an ellipsis', () => {
    const title = shortTitle('In two short sentences: what is this project for, and which stage is it at? Read the file.')
    expect(title).toBe('In two short sentences: what is this project for, and which…')
    expect(shortTitle('short one')).toBe('short one')
  })

  test('entries are numbered and capped', () => {
    let state = NEW_CONSOLE
    for (let n = 0; n < 100; n++) state = withEntries(state, { id: nextId(state), kind: 'note', text: `${n}` })
    expect(state.entries.length).toBe(80)
    expect(state.entries.at(-1)?.id).toBe(100)
  })

  test('Windows paths get forward slashes for bash', () => {
    expect(bashPath('C:\\Users\\me\\x.md')).toBe('C:/Users/me/x.md')
  })
})

group('console shared project', () => {
  test('a new project names its goal and who does what', () => {
    const text = projectTemplate(' Ship 0.3 ', '2026-11-24')
    expect(projectGoal(text)).toBe('Ship 0.3')
    expect(text.includes('- Codex: self-contained backend tasks')).toBe(true)
    expect(text.includes('- 2026-11-24: project started.')).toBe(true)
  })

  test('a file without a project line has no goal', () => {
    expect(projectGoal('notes only')).toBe(null)
  })

  test('log entries are headed by date and who', () => {
    expect(logEntry('2026-11-24 18:40', 'You', ' check the login \n')).toBe('\n## 2026-11-24 18:40 · You\n\ncheck the login\n')
  })
})

group('console project tab', () => {
  test('decisions are the bullets under their heading', () => {
    const text = [
      '# Project: X',
      '',
      '## Decisions',
      '',
      '- 2026-11-24: started.',
      '- use gizmo',
      '',
      '## Open questions',
      '',
      '- who owns it?',
      '',
    ].join('\n')
    expect(projectSection(text, 'Decisions')).toEqual(['2026-11-24: started.', 'use gizmo'])
    expect(projectSection(text, 'Open questions')).toEqual(['who owns it?'])
    expect(projectSection(text, 'Missing')).toEqual([])
  })

  test('log items come newest first with who and the rest of the heading', () => {
    const log = [
      '# Shared log',
      '',
      '## 2026-11-24 18:38 · Codex · gpt-6.2-sol · low · Test 1',
      '',
      'gizmo',
      '',
      '## 2026-11-24 18:39 · You',
      '',
      'a note',
      '',
    ].join('\n')
    expect(logItems(log, 5)).toEqual([
      { date: '2026-11-24 18:39', who: 'You', meta: '', text: 'a note' },
      { date: '2026-11-24 18:38', who: 'Codex', meta: 'gpt-6.2-sol · low · Test 1', text: 'gizmo' },
    ])
    expect(logItems(log, 1).length).toBe(1)
  })
})

group('console flow stages', () => {
  test('a new project starts at ask, and the stage can move', () => {
    const text = projectTemplate('X', '2026-11-24')
    expect(currentStage(text)).toBe('ask')
    const moved = withStage(text, 'build')
    expect(currentStage(moved)).toBe('build')
    expect(projectSection(moved, 'Decisions')).toEqual(['2026-11-24: project started.'])
  })

  test('a project without a Stage section gets one before Decisions', () => {
    const text = ['# Project: X', '', '## Decisions', '', '- one', ''].join(String.fromCharCode(10))
    const moved = withStage(text, 'plan')
    expect(currentStage(moved)).toBe('plan')
    expect(moved.indexOf('## Stage') < moved.indexOf('## Decisions')).toBe(true)
  })

  test('next goes forward and stops at the end', () => {
    expect(nextStage('ask')).toBe('plan')
    expect(nextStage(null)).toBe('ask')
    expect(nextStage('ship')).toBe(null)
  })

  test('/stage takes a step name or next', () => {
    expect(parseCommand('/stage Review')).toEqual({ kind: 'stage', id: 'review' })
    expect(parseCommand('/stage next')).toEqual({ kind: 'stage', id: 'next' })
    expect(parseCommand('/stage lunch').kind).toBe('unknown')
  })
})

group('workflow sizes', () => {
  test('each size has its own steps', () => {
    expect(stagesFor('small').map(stage => stage.label)).toEqual(['Ask', 'Do', 'Check'])
    expect(stagesFor('medium').map(stage => stage.id)).toEqual(['ask', 'plan', 'build', 'review', 'ship'])
    expect(stagesFor('large').length).toBe(7)
  })

  test('a project records its size; one without a size is large', () => {
    expect(projectSize(projectTemplate('X', '2026-11-24', 'medium'))).toBe('medium')
    expect(projectSize('# Project: old\n\n## Stage\n\n- build\n')).toBe('large')
  })

  test('next follows the size', () => {
    expect(nextStage('ask', 'small')).toBe('build')
    expect(nextStage('plan', 'medium')).toBe('build')
    expect(nextStage('plan', 'large')).toBe('merge')
  })

  test('shrinking moves a stage the smaller size lacks to its nearest earlier step', () => {
    const large = withStage(projectTemplate('X', '2026-11-24'), 'decide')
    const medium = withSize(large, 'medium')
    expect(projectSize(medium)).toBe('medium')
    expect(currentStage(medium)).toBe('plan')
    expect(currentStage(withSize(withStage(large, 'review'), 'small'))).toBe('build')
  })

  test('/size takes small, medium or large', () => {
    expect(parseCommand('/size Medium')).toEqual({ kind: 'size', size: 'medium' })
    expect(parseCommand('/size huge').kind).toBe('unknown')
  })
})
