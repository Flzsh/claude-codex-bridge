import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { bashPath, consoleBrief, parseRunOutput } from '../../../core/console'
import type { RunResult, StartRun } from './contracts'

const windows = process.platform === 'win32'
const STDERR_LIMIT = 4000
const STOP_GRACE_MS = 3000

function runUtility(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function signalProcess(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    return process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 50))

async function stopPosixGroup(pid: number) {
  if (!signalProcess(-pid, 'SIGTERM')) return
  const deadline = Date.now() + STOP_GRACE_MS
  while (signalProcess(-pid, 0)) {
    if (Date.now() >= deadline) {
      signalProcess(-pid, 'SIGKILL')
      break
    }
    await pause()
  }
  while (signalProcess(-pid, 0)) {
    // Unreaped grandchildren still have PIDs after exit, even with no live group members.
    const members = await runUtility('ps', ['-A', '-o', 'pgid=', '-o', 'stat='])
    const alive = members.split('\n').some(line => {
      const [group, state] = line.trim().split(/\s+/)
      return group === String(pid) && state && !state.startsWith('Z')
    })
    if (!alive) return
    await pause()
  }
}

// Git Bash can reparent an exec'd process in Windows while preserving its MSYS group.
// Match the group leader by this run's unique brief and collect native PIDs for taskkill.
const windowsRunPids = `
processes=$(ps -a) || exit
while read -r pid ppid group winpid rest; do
  [[ $pid =~ ^[0-9]+$ && $pid == "$group" ]] || continue
  mapfile -d '' -t args 2>/dev/null < "/proc/$pid/cmdline" || continue
  [[ \${args[1]} == "$1" && \${args[3]} == "$2" ]] || continue
  while read -r member parent memberGroup memberWinpid rest; do
    if [[ $memberGroup == "$group" ]]; then
      printf '%s\\n' "$memberWinpid"
    fi
  done <<< "$processes"
  break
done <<< "$processes"
`

async function stopTree(pid: number, bash: string, script: string, brief: string) {
  if (!windows) return stopPosixGroup(pid)
  const pids = new Set([pid])
  const args = ['-c', windowsRunPids, 'bridge-stop', bashPath(script), bashPath(brief)]
  const output = await runUtility(bash, args).catch(() => '')
  for (const entry of output.trim().split(/\s+/)) {
    if (/^[1-9][0-9]*$/.test(entry)) pids.add(Number(entry))
  }
  const targets = [...pids]
  const taskkill = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe')
  const isAlive = (target: number) => signalProcess(target, 0)
  try {
    await runUtility(taskkill, [...targets.flatMap(target => ['/PID', String(target)]), '/T', '/F'])
  } catch (error) {
    // A target may have already exited, including as part of another target's tree.
    if (targets.some(isAlive)) throw error
  }
  while (targets.some(isAlive)) await pause()
}

export const startRun: StartRun = (request, { paths, bash }) => {
  const id = `${Date.now()}-${randomUUID()}`
  const brief = join(paths.briefsDir, `brief-${id}.md`)
  const codex = request.provider === 'codex'
  const script = join(paths.scriptsDir, codex ? 'pyr.sh' : 'agy.sh')
  // Extra variables join the run to the flow (BRIDGE_STEP and friends); only BRIDGE_* names pass.
  const extra = Object.fromEntries(Object.entries(request.env ?? {}).filter(([key]) => /^BRIDGE_[A-Z_]+$/.test(key)))
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, BRIDGE_ORIGIN: 'app' }
  if (codex) {
    if (request.model !== undefined) env.CODEX_BRIDGE_MODEL = request.model
    env.CODEX_BRIDGE_RESUME = request.session ?? ''
  } else {
    env.AGY_CONVERSATION = request.session ?? ''
  }

  let child: ChildProcess | undefined
  let stopped = false
  let closed = false
  let termination: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined
  let stdout = ''
  let stderr = ''
  const addStderr = (text: string) => { stderr = (stderr + text).slice(-STDERR_LIMIT) }
  const addError = (error: unknown) => addStderr(`${stderr && !stderr.endsWith('\n') ? '\n' : ''}${String(error)}\n`)

  const done = (async (): Promise<RunResult> => {
    let exitCode: number | null = null
    let failed = false
    let ownsBrief = false
    try {
      await mkdir(paths.briefsDir, { recursive: true })
      if (!stopped) {
        const file = await open(brief, 'wx')
        ownsBrief = true
        try {
          await file.writeFile(consoleBrief(request.prompt))
        } finally {
          await file.close()
        }
      }
      if (!stopped) {
        const filenames = [script, request.workdir, brief]
        const args = [...(windows ? filenames.map(bashPath) : filenames), request.mode]
        const scriptProcess = spawn(bash, args, {
          env, shell: false, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'],
        })
        child = scriptProcess
        scriptProcess.stdout.setEncoding('utf8').on('data', (text: string) => { stdout += text })
        scriptProcess.stderr.setEncoding('utf8').on('data', addStderr)
        exitCode = await new Promise<number | null>(resolve => {
          scriptProcess.once('error', error => {
            failed = true
            addError(error)
          })
          scriptProcess.once('close', code => {
            closed = true
            resolve(failed ? null : code)
          })
        })
        await termination
      }
    } catch (error) {
      failed = true
      addError(error)
    } finally {
      if (ownsBrief) {
        try {
          await rm(brief, { force: true })
        } catch (error) {
          failed = true
          addError(error)
        }
      }
    }

    const { model, effort, seconds, session, reply, exit } = parseRunOutput(stdout)
    return {
      ok: !stopped && !failed && exitCode === 0 && (exit === null || exit === 0) && reply.length > 0,
      stopped, exitCode, model, effort, seconds, session, reply, stderr,
    }
  })()

  const waitForDone = async () => { await done }
  return {
    id,
    done,
    stop: () => {
      if (!stopPromise) {
        if (closed) return waitForDone()
        stopped = true
        if (child?.pid !== undefined) {
          termination = stopTree(child.pid, bash, script, brief)
          stopPromise = termination.then(waitForDone)
        } else {
          stopPromise = waitForDone()
        }
      }
      return stopPromise
    },
  }
}
