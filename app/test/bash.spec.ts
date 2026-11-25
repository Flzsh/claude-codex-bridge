import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findBash } from '../src/main/bash'
import type { BashLookup } from '../src/main/contracts'

function fakeLookup(
  platform: string,
  files: readonly string[],
  env: BashLookup['env'] = {},
  commands: Record<string, string> = {},
): BashLookup {
  return {
    platform,
    env,
    exists: path => files.includes(path),
    which: command => commands[command] ?? null,
  }
}

const bridgeOverride = 'D:/Bridge Tools/bash.exe'
const claudeOverride = 'D:/Claude Tools/bash.exe'
const programFiles = 'C:/Program Files/Git/bin/bash.exe'
const programFilesX86 = 'C:/Program Files (x86)/Git/bin/bash.exe'
const gitFromPath = 'D:\\Portable Git\\cmd\\git.exe'
const bashBesideGit = 'D:/Portable Git/bin/bash.exe'

test('Windows picks the first existing candidate in priority order', () => {
  const env = { BRIDGE_BASH: bridgeOverride, CLAUDE_CODE_GIT_BASH_PATH: claudeOverride }
  const order = [bridgeOverride, claudeOverride, programFiles, programFilesX86, bashBesideGit]
  for (const [index, path] of order.entries()) {
    const lookup = fakeLookup('win32', order.slice(index), env, { git: gitFromPath })
    assert.deepEqual(findBash(lookup), { path })
  }
})

test('Windows finds bash next to Git when PATH already points at its bin directory', () => {
  const lookup = fakeLookup('win32', [bashBesideGit], {}, { git: 'D:/Portable Git/bin/GIT.EXE' })
  assert.deepEqual(findBash(lookup), { path: bashBesideGit })
})

test('Windows skips WSL overrides regardless of case and slash direction', () => {
  const bridgeWsl = 'c:\\WINDOWS\\System32\\BASH.EXE'
  const claudeWsl = 'C:/Windows\\SYSTEM32/bash.exe'
  const lookup = fakeLookup('win32', [bridgeWsl, claudeWsl, programFiles], {
    BRIDGE_BASH: bridgeWsl,
    CLAUDE_CODE_GIT_BASH_PATH: claudeWsl,
  })
  assert.deepEqual(findBash(lookup), { path: programFiles })
})

test('Windows skips the WSL stub under a configured system root', () => {
  const wsl = 'D:/WINNT/System32/./bash.exe'
  const lookup = fakeLookup('win32', [wsl, bashBesideGit], {
    BRIDGE_BASH: wsl,
    SystemRoot: 'D:\\WinNT\\',
  }, { git: gitFromPath })
  assert.deepEqual(findBash(lookup), { path: bashBesideGit })
})

test('Windows reports missing Git Bash even when bare bash is on PATH', () => {
  const pathBash = 'C:/Tools/bin/bash.exe'
  const lookup = fakeLookup('win32', [pathBash], {}, { git: gitFromPath, bash: pathBash })
  const result = findBash(lookup)
  assert.ok('error' in result)
  assert.match(result.error, /Git Bash/i)
})

test('Unix prefers an existing BRIDGE_BASH to bash on PATH', () => {
  const env = { BRIDGE_BASH: '/opt/tools/bash' }
  const lookup = fakeLookup('darwin', ['/opt/tools/bash', '/bin/bash'], env, { bash: '/bin/bash' })
  assert.deepEqual(findBash(lookup), { path: '/opt/tools/bash' })
})

test('Unix uses bash on PATH when BRIDGE_BASH is missing', () => {
  const env = { BRIDGE_BASH: '/missing/bash', CLAUDE_CODE_GIT_BASH_PATH: '/opt/other/bash' }
  const lookup = fakeLookup('linux', ['/opt/other/bash', '/usr/bin/bash'], env, { bash: '/usr/bin/bash' })
  assert.deepEqual(findBash(lookup), { path: '/usr/bin/bash' })
})

test('Unix rejects a missing bash on PATH', () => {
  const result = findBash(fakeLookup('linux', [], {}, { bash: '/missing/bash' }))
  assert.ok('error' in result)
  assert.match(result.error, /bash/i)
})
