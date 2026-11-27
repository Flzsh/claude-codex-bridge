import { describe as group, expect, test } from 'claude-code/testing'

import { describeTool } from './status'

group('describeTool', () => {
  test('a command says what it is for, or what it runs', () => {
    expect(describeTool('Bash', { command: 'npm test', description: 'Run the app tests' })).toBe('Run the app tests')
    expect(describeTool('Bash', { command: 'npm test' })).toBe('running npm test')
  })

  test('files are named by their last part', () => {
    expect(describeTool('Read', { file_path: 'C:/work/app/src/main/main.ts' })).toBe('reading main.ts')
    expect(describeTool('Edit', { file_path: '/repo/core/flow.ts' })).toBe('editing flow.ts')
  })

  test('long text is cut short', () => {
    const said = describeTool('Bash', { command: 'x'.repeat(200) })
    expect(said.length <= 'running '.length + 40).toBe(true)
    expect(said.endsWith('…')).toBe(true)
  })

  test('other tools get a plain phrase', () => {
    expect(describeTool('Grep', { pattern: 'status.json' })).toBe('searching for status.json')
    expect(describeTool('mcp__github__get_issue', {})).toBe('using github')
    expect(describeTool('Something', {})).toBe('using Something')
  })
})
