import { win32 } from 'node:path'

import { bashPath } from '../../../core/console'
import type { BashLookup, FindBash } from './contracts'

function windowsPathKey(path: string): string {
  return bashPath(win32.normalize(path)).replace(/^\/\/[?.]\//, '').replace(/\/$/, '').toLowerCase()
}

function isWslBash(path: string, env: BashLookup['env']): boolean {
  const root = /^(.*)\/(?:system32|sysnative)\/bash\.exe$/.exec(windowsPathKey(path))?.[1]
  if (!root) return false
  return /^[a-z]:\/windows$/.test(root)
    || [env.SystemRoot, env.WINDIR].some(dir => dir && windowsPathKey(dir) === root)
}

export const findBash: FindBash = ({ env, platform, exists, which }) => {
  if (platform !== 'win32') {
    const override = env.BRIDGE_BASH
    if (override && exists(override)) return { path: override }
    const fromPath = which('bash')
    if (fromPath && exists(fromPath)) return { path: fromPath }
    return { error: 'Bash was not found. Install Bash or set BRIDGE_BASH to its path.' }
  }

  const usable = (path: string | undefined): path is string =>
    Boolean(path && !isWslBash(path, env) && exists(path))
  for (const path of [
    env.BRIDGE_BASH,
    env.CLAUDE_CODE_GIT_BASH_PATH,
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
  ]) {
    if (usable(path)) return { path }
  }

  const git = which('git')
  if (git && win32.basename(git).toLowerCase() === 'git.exe') {
    const gitDir = win32.dirname(git)
    const bin = win32.basename(gitDir).toLowerCase() === 'cmd' ? win32.join(gitDir, '..', 'bin') : gitDir
    const path = bashPath(win32.join(bin, 'bash.exe'))
    if (usable(path)) return { path }
  }

  return { error: 'Git Bash was not found. Install Git for Windows or set BRIDGE_BASH to its bash.exe.' }
}
