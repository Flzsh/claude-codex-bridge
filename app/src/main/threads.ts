import type { Finish, Reserve, Reset, Threads } from './contracts'

export function newThreads(): Threads {
  return {
    codex: { session: null, generation: 0, runningId: null },
    gemini: { session: null, generation: 0, runningId: null },
  }
}

export const reserve: Reserve = (threads, provider, runId) => {
  const thread = threads[provider]
  if (thread.runningId !== null) return null
  return { ...threads, [provider]: { ...thread, runningId: runId } }
}

export const finish: Finish = (threads, provider, runId, generationAtStart, session) => {
  const thread = threads[provider]
  if (thread.runningId !== runId) return threads
  const nextSession = thread.generation === generationAtStart && session !== null ? session : thread.session
  return { ...threads, [provider]: { ...thread, session: nextSession, runningId: null } }
}

export const reset: Reset = (threads, provider) => {
  const thread = threads[provider]
  return { ...threads, [provider]: { ...thread, session: null, generation: thread.generation + 1 } }
}
