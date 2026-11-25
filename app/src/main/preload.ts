// The window's only door to the app: a short list of calls and events.
// No Node, no file paths beyond the ones main chooses to share.

import { contextBridge, ipcRenderer } from 'electron'

type Provider = 'codex' | 'gemini'

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

const EVENTS = new Set(['state', 'lines', 'runs', 'project', 'companion', 'flow'])

contextBridge.exposeInMainWorld('bridge', {
  state: call('state'),
  flow: call('flow'),
  answerGate: (gate: string, answer: string, text?: string, t0?: number) => ipcRenderer.invoke('answerGate', gate, answer, text, t0),
  setPaused: (paused: boolean) => ipcRenderer.invoke('setPaused', paused),
  steer: (text: string) => ipcRenderer.invoke('steer', text),
  setTheme: (theme: string) => ipcRenderer.invoke('setTheme', theme),
  showFlow: (id: string | null) => ipcRenderer.invoke('showFlow', id),
  pickFolder: call('pickFolder'),
  setWorkdir: (path: string) => ipcRenderer.invoke('setWorkdir', path),
  send: (provider: Provider, prompt: string) => ipcRenderer.invoke('send', provider, prompt),
  stop: (provider: Provider) => ipcRenderer.invoke('stop', provider),
  newThread: (provider: Provider) => ipcRenderer.invoke('newThread', provider),
  clear: (provider: Provider) => ipcRenderer.invoke('clear', provider),
  setEffort: (provider: Provider, effort: string | null) => ipcRenderer.invoke('setEffort', provider, effort),
  setModel: (model: string) => ipcRenderer.invoke('setModel', model),
  setMode: (mode: string) => ipcRenderer.invoke('setMode', mode),
  project: call('project'),
  startProject: (goal: string) => ipcRenderer.invoke('startProject', goal),
  setStage: (stage: string) => ipcRenderer.invoke('setStage', stage),
  setSize: (size: string) => ipcRenderer.invoke('setSize', size),
  addNote: (text: string) => ipcRenderer.invoke('addNote', text),
  runs: call('runs'),
  run: (id: string) => ipcRenderer.invoke('run', id),
  runReply: (id: string) => ipcRenderer.invoke('runReply', id),
  handoff: (mode: 'fill' | 'send', text: string) => ipcRenderer.invoke('handoff', mode, text),
  pin: call('pin'),
  companionToggle: call('companionToggle'),
  companionHover: (isOver: boolean) => ipcRenderer.invoke('companionHover', isOver),
  companionOpen: call('companionOpen'),
  openFolder: call('openFolder'),
  on: (event: string, listener: (payload: unknown) => void) => {
    if (!EVENTS.has(event)) return () => undefined
    const wrapped = (_event: unknown, payload: unknown) => listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  },
})
