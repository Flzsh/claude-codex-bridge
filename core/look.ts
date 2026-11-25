import type { JobState, Provider } from '../types'
import { type Lane, LANES, STAGES } from './console'

// The bridge's look, shared by the band and the console. Mid-tone colours that
// read on light and dark alike; Claude's is the theme's own clay (`claude`).

export const CODEX_COLOR = '#3E9B83'
export const GEMINI_COLOR = '#6B7FD7'
export const CLAY = '#D97757'
/** A neutral wash for blocks and the active tab: a tint, so it sits on either theme. */
export const TINT = 'rgba(127, 127, 127, 0.10)'
export const TINT_STRONG = 'rgba(127, 127, 127, 0.18)'

export const PROVIDER_COLOR: Record<Provider, string> = { codex: CODEX_COLOR, gemini: GEMINI_COLOR }

/** The colour of whoever wrote a shared-log entry. */
export function whoColor(who: string): string {
  if (/^codex/i.test(who)) return CODEX_COLOR
  if (/^gemini/i.test(who)) return GEMINI_COLOR
  if (/^claude/i.test(who)) return 'claude'
  return 'text'
}

export const STATE_MARK: Record<JobState, string> = { running: '◐', done: '✓', failed: '✗', lost: '?' }
export const STATE_COLOR: Record<JobState, string> = {
  running: 'claude',
  done: 'success',
  failed: 'error',
  lost: 'warning',
}

/**
 * The bridge mark: Claude above, Codex and Gemini below, joined. While work
 * runs, a small dot travels the joins, work passing between the three.
 */
export function markSvg(isBusy: boolean): string {
  const travel = isBusy
    ? `<circle r="1.9" fill="${CLAY}"><animateMotion dur="2.4s" repeatCount="indefinite" path="M16 8.5 L23.5 21.5 L8.5 21.5 Z"/></circle>`
    : ''
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 30" width="32" height="30">',
    '<path d="M16 8.5 L23.5 21.5 L8.5 21.5 Z" fill="none" stroke="#8a8a8a" stroke-opacity="0.45" stroke-width="1.5" stroke-linejoin="round"/>',
    `<circle cx="16" cy="8.5" r="4.2" fill="${CLAY}"/>`,
    `<circle cx="8.5" cy="21.5" r="4.2" fill="${CODEX_COLOR}"/>`,
    `<circle cx="23.5" cy="21.5" r="4.2" fill="${GEMINI_COLOR}"/>`,
    travel,
    '</svg>',
  ].join('')
}

/** Three dots that breathe in turn: someone is thinking. */
export function thinkingSvg(color: string): string {
  const dot = (cx: number, begin: string) =>
    `<circle cx="${cx}" cy="5" r="2.6" fill="${color}" opacity="0.25"><animate attributeName="opacity" values="0.25;1;0.25" dur="1.2s" begin="${begin}" repeatCount="indefinite"/></circle>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 10" width="26" height="10">${dot(5, '0s')}${dot(13, '0.2s')}${dot(21, '0.4s')}</svg>`
}

/** What each lane does in a step, as written in its box on the Flow map. */
const BOX_TEXT: Record<string, Partial<Record<Lane, string>>> = {
  ask: { you: 'Ask' },
  plan: { claude: 'Plan', gemini: 'Own plan' },
  merge: { claude: 'Merge' },
  decide: { you: 'Decide' },
  build: { claude: 'UI + checks', codex: 'Backend' },
  review: { gemini: 'Copy review', codex: 'Diff review' },
  ship: { claude: 'Check', you: 'Say yes' },
}

const LANE_NAME: Record<Lane, string> = { you: 'You', claude: 'Claude', gemini: 'Gemini', codex: 'Codex' }
const LANE_COLOR: Record<Lane, string> = { you: '#8f8f8f', claude: CLAY, gemini: GEMINI_COLOR, codex: CODEX_COLOR }
const MUTED = '#8f8f8f'

/**
 * The workflow as a map: lanes for You, Claude, Gemini and Codex, one row per
 * step. Done steps are ticked and quiet, the current one glows clay, and a lane
 * whose agent has a job running pulses at its head.
 */
export function flowSvg(stageId: string | null, working: readonly Lane[]): string {
  const gutter = 92
  const laneWidth = 92
  const top = 34
  const rowHeight = 42
  const boxWidth = 80
  const boxHeight = 26
  const width = gutter + laneWidth * LANES.length + 4
  const height = top + rowHeight * STAGES.length + 6
  const current = STAGES.findIndex(stage => stage.id === stageId)
  const center = (lane: Lane) => gutter + laneWidth * LANES.indexOf(lane) + laneWidth / 2
  const middle = (row: number) => top + rowHeight * row + rowHeight / 2
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">`,
  ]

  // Lane heads, and a faint line down each lane.
  for (const lane of LANES) {
    const x = center(lane)
    const isWorking = working.includes(lane)
    const pulse = isWorking
      ? '<animate attributeName="r" values="3.5;5.5;3.5" dur="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0.5;1" dur="1.4s" repeatCount="indefinite"/>'
      : ''
    out.push(
      `<line x1="${x}" y1="${top - 6}" x2="${x}" y2="${height - 4}" stroke="${MUTED}" stroke-opacity="0.15" stroke-dasharray="2 4"/>`,
      `<circle cx="${x - 24}" cy="14" r="3.5" fill="${LANE_COLOR[lane]}">${pulse}</circle>`,
      `<text x="${x - 16}" y="18" font-size="12" font-weight="600" fill="${LANE_COLOR[lane]}">${LANE_NAME[lane]}${isWorking ? ' …' : ''}</text>`,
    )
  }

  // Joins from each box of a step to each box of the next; the ones into the current step are lit.
  STAGES.forEach((stage, row) => {
    const next = STAGES[row + 1]
    if (!next) return
    const isLit = row + 1 === current
    for (const from of stage.lanes) {
      for (const to of next.lanes) {
        const x1 = center(from)
        const y1 = middle(row) + boxHeight / 2
        const x2 = center(to)
        const y2 = middle(row + 1) - boxHeight / 2
        const bend = (y2 - y1) / 2
        out.push(
          `<path d="M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}" fill="none" stroke="${isLit ? CLAY : MUTED}" stroke-opacity="${isLit ? 0.8 : 0.3}" stroke-width="${isLit ? 1.6 : 1.1}"/>`,
        )
      }
    }
  })

  // The steps: a name in the gutter and a box in each lane that works in it.
  STAGES.forEach((stage, row) => {
    const y = middle(row)
    const isDone = current !== -1 && row < current
    const isNow = row === current
    const mark = isDone ? '✓' : `${row + 1}`
    out.push(
      `<text data-stage="${stage.id}" x="8" y="${y + 4}" font-size="11.5" font-weight="${isNow ? 700 : 500}" fill="${isNow ? CLAY : MUTED}">${mark}  ${stage.label.replace('&', '&amp;')}</text>`,
    )
    for (const lane of stage.lanes) {
      const x = center(lane) - boxWidth / 2
      const label = BOX_TEXT[stage.id]?.[lane] ?? ''
      out.push(
        isNow
          ? `<rect data-stage="${stage.id}" x="${x}" y="${y - boxHeight / 2}" width="${boxWidth}" height="${boxHeight}" rx="8" fill="${CLAY}" fill-opacity="0.14" stroke="${CLAY}" stroke-width="1.6"><animate attributeName="stroke-opacity" values="1;0.35;1" dur="2.2s" repeatCount="indefinite"/></rect>`
          : `<rect data-stage="${stage.id}" x="${x}" y="${y - boxHeight / 2}" width="${boxWidth}" height="${boxHeight}" rx="8" fill="${MUTED}" fill-opacity="${isDone ? 0.12 : 0.04}" stroke="${MUTED}" stroke-opacity="${isDone ? 0 : 0.4}"/>`,
        `<text data-stage="${stage.id}" x="${center(lane)}" y="${y + 4}" text-anchor="middle" font-size="11" font-weight="${isNow ? 600 : 400}" fill="${isNow ? CLAY : MUTED}" fill-opacity="${isDone ? 0.75 : 1}">${label}</text>`,
      )
      if (isNow && working.includes(lane)) {
        out.push(
          `<circle cy="${y + boxHeight / 2 - 4}" r="1.6" fill="${CLAY}"><animate attributeName="cx" values="${x + 10};${x + boxWidth - 10};${x + 10}" dur="1.8s" repeatCount="indefinite"/></circle>`,
        )
      }
    }
  })

  out.push('</svg>')
  return out.join('')
}

/** The flow as lines, for the terminal, which draws no SVG. */
export function flowText(stageId: string | null, working: readonly Lane[]): string[] {
  const current = STAGES.findIndex(stage => stage.id === stageId)
  return STAGES.map((stage, row) => {
    const mark = current !== -1 && row < current ? '✓' : row === current ? '▶' : '·'
    const who = stage.lanes.map(lane => `${LANE_NAME[lane]}${working.includes(lane) ? ' (working)' : ''}`).join(', ')
    return `${mark} ${row + 1}. ${stage.label} — ${who}`
  })
}
