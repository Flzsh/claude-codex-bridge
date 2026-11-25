// Follow a single Codex log while its runner is alive. The runner creates a
// stop marker after closing the log, so the last complete line can be read.
import { appendFileSync, closeSync, existsSync, openSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout } from 'node:timers/promises'

const [logPath, workdir, id] = process.argv.slice(2)
const flow = process.env.BRIDGE_FLOW_ID || undefined
const eventsPath = join(workdir, '.bridge', 'flow.jsonl')
const stop = join(dirname(logPath), 'flowtail.stop')
const interval = 500
const pending = []
const buffer = Buffer.alloc(64 * 1024)
const decoder = new StringDecoder('utf8')
let offset = 0
let partial = ''
let nextLine = ''
let lastEvent = -Infinity

const clip = (text, length) => [...text].slice(0, length).join('')

function shortCommand(line) {
  const wrapper = /^(?:"[^"]+"|'[^']+'|\S+)\s+(?:-Command|-[a-z]*c[a-z]*)\s+/i.exec(line)
  if (!wrapper || !/(?:powershell|pwsh|bash)(?:\.exe)?["']?\s/i.test(wrapper[0])) return clip(line, 60)
  const wrapped = line.slice(wrapper[0].length).replace(/(.*["']) in (?:[A-Za-z]:[\\/]|[\\/]).*$/, '$1')
  const quote = wrapped[0]
  const command = (quote === '"' || quote === "'") && wrapped.endsWith(quote) ? wrapped.slice(1, -1) : wrapped
  return clip(command, 60)
}

function queue(mark, text) {
  // A burst is sampled instead of replayed long after the work happened.
  if (pending.length === 3) pending.shift()
  pending.push([mark, text])
}

function readLine(raw) {
  const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim()
  const previous = nextLine
  nextLine = ''
  if (line === 'exec' || line === 'codex') nextLine = line
  else if (line && previous === 'exec') queue('●', `Run ${shortCommand(line)}`)
  else if (line && previous === 'codex') queue('✻', clip(line, 120))
  else if (/^succeeded in\s/.test(line)) queue('⎿', 'ok')
  else {
    const exit = /^exited (\d+) in\s/.exec(line)
    if (exit) queue('⎿', `exit ${exit[1]}`)
  }
}

function readNewBytes() {
  let file
  try { file = openSync(logPath, 'r') } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  try {
    let count
    do {
      count = readSync(file, buffer, 0, buffer.length, offset)
      offset += count
      const lines = (partial + decoder.write(buffer.subarray(0, count))).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) readLine(line)
    } while (count === buffer.length)
  } finally {
    closeSync(file)
  }
}

function writePending() {
  if (pending.length === 0 || Date.now() - lastEvent < interval) return
  const now = Date.now()
  const event = { t: now / 1000, flow, id, log: pending.shift() }
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`)
  lastEvent = now
}

while (!existsSync(stop)) {
  readNewBytes()
  writePending()
  await setTimeout(100)
}
readNewBytes()
const lastLine = partial + decoder.end()
if (lastLine) readLine(lastLine)
while (pending.length) {
  const delay = interval - (Date.now() - lastEvent)
  if (delay > 0) await setTimeout(delay)
  writePending()
}
