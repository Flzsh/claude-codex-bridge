import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { ConsoleState, Provider } from '../types'
import {
  bashPath,
  CODEX_MODELS,
  type Command,
  consoleBrief,
  HELP,
  logEntry,
  NEW_CONSOLE,
  nextId,
  parseCommand,
  parseRunOutput,
  PROJECT_DIR,
  projectGoal,
  projectTemplate,
  withEntries,
  withSize,
} from '../core/console'
import { setEffort } from './efforts'
import { openApp } from './launch'
import { NO_EFFORTS } from '../core/jobs'
import { EFFORTS, modelName, providerName } from '../core/jobs'

// A console beside the chat, in the shape of a terminal CLI: pick Codex or
// Gemini, a model, an effort and what Codex may do, then talk to it. Each
// prompt runs through pyr.sh / agy.sh, so it also shows on the card, and
// follow-ups continue the same conversation until /new.

// The effort picked per provider; the same state hooks/efforts.ts saves.
const efforts = atom({ plugin: 'codex-bridge', key: 'efforts' } as const, NO_EFFORTS)
const PANE = 'bridge-console'
const TITLE = 'Bridge console'
// Change the tag when ConsoleState's fields change: it declines what an
// earlier version stored, which outlives a reload.
const consoleState = atom({ plugin: 'codex-bridge', key: 'console' } as const, NEW_CONSOLE, { shape: 'console-2' })

// Set at session start.
let cwd = ''
let root = ''
let bash = 'bash'
// Ends the running prompt's script; null when nothing runs (or after a reload).
let stopRun: (() => void) | null = null

const GIT_BASH = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe']

/** Git Bash on Windows (plain `bash` there may be WSL's), else bash on PATH. */
export async function findBash($: EngineInterface, pluginRoot = root): Promise<string> {
  if (!/^[A-Za-z]:/.test(pluginRoot)) return 'bash'
  for (const path of GIT_BASH) if (await $.fs.exists(path)) return path
  return 'bash'
}

const projectFile = () => `${cwd}/${PROJECT_DIR}/project.md`
const logFile = () => `${cwd}/${PROJECT_DIR}/log.md`

/** Local time as the shared log writes it: 2026-11-24 18:40. */
async function stamp($: EngineInterface): Promise<string> {
  const d = new Date(await $.clock.now())
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

async function readOr($: EngineInterface, path: string): Promise<string> {
  try {
    return (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  } catch {
    return ''
  }
}

/** Reads the shared project's goal into the console's state. */
async function loadProject($: EngineInterface) {
  const text = await readOr($, projectFile())
  const goal = text ? (projectGoal(text) ?? 'untitled') : null
  await update($, consoleState, state => ({ ...state, project: goal }))
}

/**
 * Adds an entry to .bridge/log.md by appending (never rewriting, so entries the
 * app or a job adds at the same moment survive). The plugin's file calls can't
 * append, so Node does it.
 */
async function appendLog($: EngineInterface, who: string, text: string) {
  // The header only if the log is new (exclusive create), then the entry appended.
  const script =
    'const fs = require("fs"); try { fs.writeFileSync(process.argv[1], "# Shared log\\n", { flag: "wx" }) } catch {} fs.appendFileSync(process.argv[1], process.argv[2])'
  const { exitCode } = await $.process.run(['node', '-e', script, logFile(), logEntry(await stamp($), who, text)], {
    timeoutMs: 15_000,
  })
  if (exitCode !== 0) throw new Error('append failed')
}

/** Removes a file the plugin wrote (its file calls can't delete). Best effort. */
async function removeFile($: EngineInterface, path: string) {
  await $.process.run(['node', '-e', 'require("fs").rmSync(process.argv[1], { force: true })', path], { timeoutMs: 15_000 }).catch(() => undefined)
}

async function note($: EngineInterface, text: string) {
  await update($, consoleState, state => withEntries(state, { id: nextId(state), kind: 'note', text }))
}

async function send($: EngineInterface, prompt: string) {
  const state = await read($, consoleState)
  if (state.runningSince !== null) return note($, 'Still working on the last prompt. /stop ends it.')
  const provider = state.provider
  // A brief of its own per prompt, so two sessions' prompts never share one.
  const brief = `${root}/console/brief-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`
  try {
    await $.fs.write(brief, consoleBrief(prompt))
  } catch {
    return note($, 'Could not write the brief file.')
  }

  const now = Math.floor((await $.clock.now()) / 1000)
  await update($, consoleState, current => ({
    ...withEntries(current, { id: nextId(current), kind: 'you', provider, text: prompt }),
    runningSince: now,
  }))

  const session = state.sessions[provider]
  const script = `${root}/skills/codex-bridge/${provider === 'codex' ? 'pyr.sh' : 'agy.sh'}`
  const env: Record<string, string> =
    provider === 'codex'
      ? { CODEX_BRIDGE_MODEL: state.codexModel, CODEX_BRIDGE_RESUME: session ?? '' }
      : { AGY_CONVERSATION: session ?? '' }

  // The run outlives this handler: it reads the script's output, then writes the reply.
  void (async () => {
    let out = ''
    let code: number | null = null
    let isStopped = false
    try {
      const stream = $.process.spawn({
        argv: [bash, bashPath(script), bashPath(cwd), bashPath(brief), state.mode],
        cwd,
        env,
      })
      stopRun = () => {
        isStopped = true
        void stream.return(undefined as never)
      }
      for await (const chunk of stream) out += chunk.text
      code = (await stream.result).code
    } catch (error) {
      if (!isStopped) out ||= `Could not start ${providerName(provider)}: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      stopRun = null
    }
    // pyr.sh / agy.sh copied the brief into the run folder; this one is done.
    await removeFile($, brief)

    const run = parseRunOutput(out)
    const isFailed = isStopped || code !== 0 || run.exit !== 0
    const label = [
      providerName(provider),
      run.model ? modelName(run.model) : '',
      run.effort,
      run.seconds === null ? '' : `${run.seconds}s`,
    ]
      .filter(Boolean)
      .join(' · ')
    await update($, consoleState, current => ({
      ...withEntries(current, {
        id: nextId(current),
        kind: 'reply',
        provider,
        label: isStopped ? `${providerName(provider)} · stopped` : label,
        text: isStopped ? 'Stopped. A Codex process may still finish on its own; its run shows on the card.' : run.reply || 'No reply.',
        isFailed,
      }),
      runningSince: null,
      sessions: run.session && !isStopped ? { ...current.sessions, [provider]: run.session } : current.sessions,
    }))
  })()
}

async function apply($: EngineInterface, command: Command) {
  switch (command.kind) {
    case 'prompt':
      return command.text ? send($, command.text) : undefined
    case 'new': {
      await update($, consoleState, state => ({ ...state, sessions: { ...state.sessions, [state.provider]: null } }))
      const { provider } = await read($, consoleState)
      return note($, `New ${providerName(provider)} conversation.`)
    }
    case 'stop':
      if (!stopRun) return note($, 'Nothing is running.')
      stopRun()
      return
    case 'clear':
      return update($, consoleState, state => ({ ...state, entries: [] }))
    case 'help':
      return note($, HELP)
    case 'provider':
      await update($, consoleState, state => ({ ...state, provider: command.provider }))
      return note($, `${providerName(command.provider)} answers now.`)
    case 'model':
      if (!(CODEX_MODELS as readonly string[]).includes(command.model)) {
        return note($, `Codex models here: ${CODEX_MODELS.join(', ')}`)
      }
      await update($, consoleState, state => ({ ...state, codexModel: command.model }))
      return note($, `Codex model: ${modelName(command.model)}.`)
    case 'effort': {
      const { provider } = await read($, consoleState)
      if (command.level !== null && !(EFFORTS[provider] as readonly string[]).includes(command.level)) {
        return note($, `${providerName(provider)} efforts: ${EFFORTS[provider].join(', ')}, or default`)
      }
      await setEffort($, provider, command.level)
      return note($, `${providerName(provider)} effort: ${command.level ?? 'default'}.`)
    }
    case 'mode':
      await update($, consoleState, state => ({ ...state, mode: command.mode }))
      return note($, command.mode === 'read-only' ? 'Codex may read only.' : 'Codex may edit files in this folder.')
    case 'project': {
      const { project } = await read($, consoleState)
      if (command.goal === null) {
        return note(
          $,
          project
            ? `Project: ${project}. Shared files: ${PROJECT_DIR}/project.md (goal, who does what, decisions) and ${PROJECT_DIR}/log.md.`
            : 'No shared project in this folder. /project start <goal> makes one.',
        )
      }
      if (project) return note($, `A project is already here: ${project}. Edit ${PROJECT_DIR}/project.md to change it.`)
      try {
        const date = (await stamp($)).slice(0, 10)
        await $.fs.write(projectFile(), projectTemplate(command.goal, date))
        await appendLog($, 'You', `Started the project: ${command.goal}`)
      } catch {
        return note($, `Could not write ${PROJECT_DIR}/ in this folder.`)
      }
      await loadProject($)
      return note($, `Project started in ${PROJECT_DIR}/. Codex and Gemini read it on every prompt, and their replies go into the log.`)
    }
    case 'note': {
      if (!(await read($, consoleState)).project) return note($, 'No shared project here yet. /project start <goal> makes one.')
      try {
        await appendLog($, 'You', command.text)
      } catch {
        return note($, 'Could not write the shared log.')
      }
      return note($, 'Added to the shared log.')
    }
    case 'claude': {
      const state = await read($, consoleState)
      const last = [...state.entries].reverse().find(entry => entry.kind === 'reply')
      const quoted = last && last.kind === 'reply' ? `${last.label} replied in the bridge console:\n\n${last.text}` : ''
      if (!command.text) {
        if (!quoted) return note($, 'No reply to hand over yet.')
        await $.prompt.fill({ text: `${quoted}\n\n` })
        return note($, 'The last reply is in your prompt box: add what you want Claude to do and send it.')
      }
      const project = state.project ? `\n\nShared project: ${PROJECT_DIR}/project.md and ${PROJECT_DIR}/log.md.` : ''
      await $.prompt.submit({ text: `${command.text}${quoted ? `\n\n${quoted}` : ''}${project}` })
      return note($, 'Sent to Claude.')
    }
    case 'size': {
      const text = await readOr($, projectFile())
      if (!text) return note($, 'No shared project here yet. /project start <goal> makes one.')
      await $.fs.write(projectFile(), withSize(text, command.size))
      return note($, `Workflow size: ${command.size}.`)
    }
    case 'unknown':
      return note($, `Unknown command: ${command.text}. /help lists them.`)
  }
}

/** Enter in the field: draw it fresh and empty, then do what was typed. */
async function submit($: EngineInterface, value: string) {
  await update($, consoleState, state => ({ ...state, sends: state.sends + 1 }))
  await apply($, parseCommand(value))
}

/** Opens the console pane beside the chat. */
export async function openConsole($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE, focus: true })
}

/** The console's part of session start; the plugin's one session.start hook calls it. */
export async function startConsole($: EngineInterface, sessionCwd: string) {
  cwd = sessionCwd
  root = $.plugin.root.replace(/[\\/]+$/, '')
  bash = await findBash($)
  // A prompt that was running when the plugin reloaded has no reader any more.
  const state = await read($, consoleState)
  if (state.runningSince !== null) {
    await update($, consoleState, current => ({ ...current, runningSince: null }))
    await note($, 'The plugin reloaded while a prompt ran; its run still shows on the card.')
  }
  await loadProject($)
  try {
    await $.command.register({
      name: 'bridge',
      description: 'Open the Bridge app (or `/bridge console` for the console beside the chat)',
      argumentHint: '[console]',
    })
  } catch {
    $.ui.log('codex-bridge: /bridge is taken by another plugin; use Console on the card instead', { to: 'debug' })
  }
}

export function registerConsole(on: On) {
  on('command.run', { command: 'bridge' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'console') {
      await openConsole($)
      return { text: 'Bridge console opened.' }
    }
    const opened = await openApp($, root, cwd)
    if (!opened) await openConsole($)
    return { text: opened ? 'Bridge app opened.' : 'The Bridge app is not set up; opened the console instead.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Input, Markdown, Select, Text } = $.ui.resolve(e)
    const state = await read($, consoleState)
    const picked = await read($, efforts)
    const provider = state.provider
    const effort = picked[provider]
    const room = Math.max(4, (e.viewport?.rows ?? 40) - 14)
    const folder = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd

    const status = [
      providerName(provider),
      provider === 'codex' ? modelName(state.codexModel) : 'default model',
      effort ?? 'default effort',
      provider === 'codex' ? state.mode : 'text only',
      state.sessions[provider] ? 'continuing' : 'new conversation',
      state.project ? `project: ${state.project}` : folder,
    ].join(' · ')

    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          {status}
        </Text>
        <Box flexDirection="row" marginTop={1}>
          <Select
            key="console-provider"
            label="AI"
            value={provider}
            options={[
              { value: 'codex', label: 'Codex' },
              { value: 'gemini', label: 'Gemini' },
            ]}
            onSelect={value => void apply($, { kind: 'provider', provider: value === 'gemini' ? 'gemini' : 'codex' })}
          />
          {provider === 'codex' && (
            <Select
              key="console-model"
              label="Model"
              value={state.codexModel}
              options={CODEX_MODELS.map(model => ({ value: model, label: modelName(model) }))}
              onSelect={value => void apply($, { kind: 'model', model: value })}
            />
          )}
          <Select
            key={`console-effort-${provider}`}
            label="Effort"
            value={effort ?? 'default'}
            options={['default', ...EFFORTS[provider]].map(level => ({ value: level }))}
            onSelect={value => void apply($, { kind: 'effort', level: value === 'default' ? null : value })}
          />
          {provider === 'codex' && (
            <Select
              key="console-mode"
              label="Mode"
              value={state.mode}
              options={[
                { value: 'read-only', label: 'read only' },
                { value: 'workspace-write', label: 'may edit' },
              ]}
              onSelect={value =>
                void apply($, { kind: 'mode', mode: value === 'workspace-write' ? 'workspace-write' : 'read-only' })
              }
            />
          )}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {state.entries.length === 0 && <Text dimColor>Type a prompt below. /help lists the commands.</Text>}
          {state.entries.slice(-room).map(entry =>
            entry.kind === 'you' ? (
              <Text key={`entry-${entry.id}`} color="suggestion">
                {`› ${entry.text}`}
              </Text>
            ) : entry.kind === 'reply' ? (
              <Box key={`entry-${entry.id}`} flexDirection="column" marginBottom={1}>
                <Text color={entry.isFailed ? 'error' : 'success'}>{`${entry.isFailed ? '✗' : '◆'} ${entry.label}`}</Text>
                <Markdown text={entry.text} />
              </Box>
            ) : (
              <Text key={`entry-${entry.id}`} dimColor>
                {entry.text}
              </Text>
            ),
          )}
          {state.runningSince !== null && <Text color="suggestion">{`◐ ${providerName(provider)} is working… /stop ends it`}</Text>}
        </Box>

        <Box marginTop={1}>
          <Input
            key={`console-input-${state.sends}`}
            label="›"
            placeholder={`Ask ${providerName(provider)}, or /help`}
            submitLabel="send"
            rows={2}
            autoFocus
            onSubmit={value => void submit($, value)}
          />
        </Box>
      </Box>
    )
  })
}
