import { describe as group, expect, test } from 'claude-code/testing'

import { flowSvg, flowText, markSvg, whoColor } from './look'

group('look', () => {
  test('the mark moves only while work runs', () => {
    expect(markSvg(false).includes('animateMotion')).toBe(false)
    expect(markSvg(true).includes('animateMotion')).toBe(true)
  })

  test('the flow map lights the current step and the working lanes', () => {
    const svg = flowSvg('build', ['codex'])
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.includes('Backend')).toBe(true)
    expect(svg.includes('Codex …')).toBe(true)
    expect(svg.includes('Check &amp; ship')).toBe(true)
    expect(flowSvg(null, []).includes('animate')).toBe(false)
  })

  test('the terminal gets the flow as lines', () => {
    const lines = flowText('plan', ['gemini'])
    expect(lines[0]).toBe('✓ 1. Ask — You')
    expect(lines[1]).toBe('▶ 2. Two plans — Claude, Gemini (working)')
    expect(lines[6]).toBe('· 7. Check & ship — Claude, You')
  })

  test('log authors get their colours', () => {
    expect(whoColor('Codex')).toBe('#3E9B83')
    expect(whoColor('You')).toBe('text')
  })
})
