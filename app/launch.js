// Starts the Bridge app detached, so it outlives Claude Code's plugin reloads,
// and exits at once. Usage: node app/launch.js [--workdir <folder>]
// Exit codes: 0 opened, 3 not set up (run `npm ci` in app/ once).
'use strict'

const { spawn } = require('node:child_process')
const { join } = require('node:path')
const { buildIfStale } = require('./stale.cjs')

const here = __dirname

let electron
try {
  // The electron package's main export is the path to its binary.
  electron = require(join(here, 'node_modules', 'electron'))
} catch {
  console.log(`Bridge isn't set up yet. Run once:  cd "${here}" && npm ci`)
  process.exit(3)
}

// Build when there is no build yet, or the sources changed since (a plugin update).
if (buildIfStale(here) === 'failed') {
  console.log('Bridge could not be built; see the lines above.')
  process.exit(1)
}

// The folder also travels as --workdir64 (base64url): when Bridge is already open, Windows hands the
// arguments to it through a path that can garble letters outside ASCII (a folder like OneDrive\桌面).
const args = process.argv.slice(2)
const at = args.indexOf('--workdir')
if (at !== -1 && args[at + 1]) args.push('--workdir64', Buffer.from(args[at + 1], 'utf8').toString('base64url'))
// --built: checked just now, so the app need not check again
const child = spawn(electron, [here, ...args, '--built'], { detached: true, stdio: 'ignore' })
child.unref()
console.log('Bridge opened.')
