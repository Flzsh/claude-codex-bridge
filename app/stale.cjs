// Builds the app again when its build is older than its sources (a plugin update), one build at a
// time. Shared by launch.js, run by Node, and by the app itself when it is opened from the Start
// menu, where Electron runs the build as Node (ELECTRON_RUN_AS_NODE).
'use strict'

const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')

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

/** No build yet, or the sources changed since. build.mjs writes dist/.complete last, so a build
 * that stopped half-way never looks current. */
function isStale(here) {
  const built = join(here, 'dist', '.complete')
  return Math.max(newest(join(here, 'src')), newest(join(here, '..', 'core'))) > (existsSync(built) ? statSync(built).mtimeMs : 0)
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Builds the app in `here` when it is stale: 'current' (nothing to do), 'built' or 'failed'.
 * A second caller waits for the first one's build (up to 2 min), then checks again instead of
 * building over it; a lock older than that was left behind.
 */
function buildIfStale(here, { node = process.execPath, env = process.env, quiet = false } = {}) {
  if (!isStale(here)) return 'current'
  const lock = join(here, 'build.lock')
  for (;;) {
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
    if (!isStale(here)) return 'current'
    const result = spawnSync(node, [join(here, 'build.mjs')], { cwd: here, env, stdio: quiet ? 'ignore' : 'inherit', windowsHide: true })
    return result.status === 0 ? 'built' : 'failed'
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

module.exports = { buildIfStale }
