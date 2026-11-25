// Starts the Bridge app detached, so it outlives Claude Code's plugin reloads,
// and exits at once. Usage: node app/launch.js [--workdir <folder>]
// Exit codes: 0 opened, 3 not set up (run `npm ci` in app/ once).
'use strict'

const { spawn, spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')

const here = __dirname

let electron
try {
  // The electron package's main export is the path to its binary.
  electron = require(join(here, 'node_modules', 'electron'))
} catch {
  console.log(`Bridge isn't set up yet. Run once:  cd "${here}" && npm ci`)
  process.exit(3)
}

/** The newest modification time under a folder (sources only). */
function newest(dir) {
  let latest = 0
  if (!existsSync(dir)) return latest
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) latest = Math.max(latest, newest(path))
    else if (/\.(ts|tsx|css|html)$/.test(entry.name)) latest = Math.max(latest, statSync(path).mtimeMs)
  }
  return latest
}

// Build when there is no build yet, or the sources changed since (a plugin update).
// build.mjs writes dist/.complete last, so a build that stopped half-way never looks current.
const built = join(here, 'dist', '.complete')
const isStale = () =>
  Math.max(newest(join(here, 'src')), newest(join(here, '..', 'core'))) > (existsSync(built) ? statSync(built).mtimeMs : 0)

// One build at a time: a second launch waits for the first one's build (up to 2 min),
// then checks again instead of building over it. A lock older than that was left behind.
const lock = join(here, 'build.lock')
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
if (isStale()) {
  for (let waited = 0; ; waited += 250) {
    try {
      mkdirSync(lock)
      break
    } catch {
      const age = existsSync(lock) ? Date.now() - statSync(lock).mtimeMs : 0
      if (age > 120_000) rmSync(lock, { recursive: true, force: true })
      else pause(250)
    }
  }
  try {
    if (isStale()) {
      const result = spawnSync(process.execPath, [join(here, 'build.mjs')], { cwd: here, stdio: 'inherit' })
      if (result.status !== 0) {
        console.log('Bridge could not be built; see the lines above.')
        process.exitCode = 1
      }
    }
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
  if (process.exitCode) process.exit(process.exitCode)
}

const child = spawn(electron, [here, ...process.argv.slice(2)], { detached: true, stdio: 'ignore' })
child.unref()
console.log('Bridge opened.')
