import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Provider } from '../types'
import { type Efforts, effortsText, NO_EFFORTS, parseEfforts, settingsPath } from '../core/jobs'

/** The effort picked per provider, shared by the card and the console. */
export const efforts = atom({ plugin: 'codex-bridge', key: 'efforts' } as const, NO_EFFORTS)

// The plugin's settings.json, where the picked efforts are saved for the scripts.
let settings = ''

/** Loads the saved efforts at session start. */
export async function loadEfforts($: EngineInterface) {
  settings = settingsPath($.plugin.root)
  let text = ''
  try {
    if (await $.fs.exists(settings)) text = await $.fs.read(settings)
  } catch {
    text = ''
  }
  const saved = parseEfforts(text)
  await update($, efforts, () => saved)
}

/** Picks an effort for a provider (null = default) and saves it for the next job. */
export async function setEffort($: EngineInterface, provider: Provider, effort: string | null) {
  // Merge into what is on disk now, so a pick made in another session for the other provider survives.
  let onDisk = await read($, efforts)
  try {
    if (await $.fs.exists(settings)) onDisk = parseEfforts(await $.fs.read(settings))
  } catch {
    // Unreadable: keep this session's view.
  }
  const next: Efforts = { ...onDisk, [provider]: effort }
  await update($, efforts, () => next)
  try {
    await $.fs.write(settings, effortsText(next))
  } catch {
    $.ui.toast('Could not save the effort setting', { timeoutMs: 5000 })
  }
}
