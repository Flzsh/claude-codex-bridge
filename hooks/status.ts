// Claude's own status, for the Bridge companion when no workflow is running:
// thinking, the tool it is using, or idle. One small file per session folder,
// <plugin>/status/<folder>.json, rewritten as the turn goes; the app reads it.

import type { EngineInterface } from 'claude-code'

export type ClaudeState = 'thinking' | 'tool' | 'idle'

let root = ''
let cwd = ''
let since = 0
let made = false
let last: { state: ClaudeState; detail: string } = { state: 'idle', detail: '' }
let wroteAt = 0

/** What Claude is doing now, as this session last wrote it. */
export const currentStatus = () => ({ ...last, since })

export function statusInit(pluginRoot: string, folder: string) {
  root = pluginRoot.replace(/[\\/]+$/, '')
  cwd = folder
}

/** A file name from the session's folder (any folder maps to one stable name). */
const fileName = (folder: string) => folder.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(-90) || 'session'

const base = (path: unknown) => (typeof path === 'string' ? path.split(/[\\/]/).pop() ?? path : '')
const clip = (text: unknown, n: number) => {
  const one = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** A few words for what a tool call is doing: "reading main.ts", "running npm test". */
export function describeTool(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash' || tool === 'PowerShell') return clip(input.description, 48) || `running ${clip(input.command, 40)}`
  if (tool === 'Read') return `reading ${base(input.file_path)}`
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') return `editing ${base(input.file_path ?? input.notebook_path)}`
  if (tool === 'Grep') return `searching for ${clip(input.pattern, 30)}`
  if (tool === 'Glob') return 'finding files'
  if (tool === 'WebSearch' || tool === 'WebFetch') return 'looking on the web'
  if (tool === 'Agent' || tool === 'Task') return 'asking a helper'
  if (tool === 'Skill') return `using ${clip(input.skill, 30) || 'a skill'}`
  if (tool.startsWith('mcp__')) return `using ${tool.split('__')[1] ?? 'a connector'}`
  return `using ${tool}`
}

export async function writeStatus($: EngineInterface, state: ClaudeState, detail = '', isHeartbeat = false) {
  if (!root || !cwd) return
  const t = Date.now() / 1000
  if (!isHeartbeat && (state === 'thinking' || state === 'idle' || since === 0)) since = t
  last = { state, detail }
  wroteAt = t
  try {
    if (!made) {
      // The plugin's own file calls can't make a folder, so Node does it once.
      await $.process.run(['node', '-e', 'require("fs").mkdirSync(process.argv[1], { recursive: true })', `${root}/status`], { timeoutMs: 15_000 })
      made = true
    }
    await $.fs.write(`${root}/status/${fileName(cwd)}.json`, JSON.stringify({ cwd, state, detail, since, t }))
  } catch {
    // A status is a nicety: a failed write never gets in Claude's way.
  }
}

/**
 * Writes the same status again now and then, so the app can tell this session is
 * still here (its time stays fresh) even while Claude waits for the person.
 */
export async function heartbeat($: EngineInterface, everySeconds = 30) {
  if (Date.now() / 1000 - wroteAt < everySeconds) return
  await writeStatus($, last.state, last.detail, true)
}
