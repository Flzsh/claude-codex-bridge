import type { EngineInterface } from 'claude-code'

/**
 * Opens the Bridge desktop app on this session's folder (app/launch.js starts
 * it detached and exits). Says how to set it up when it isn't yet. True when it opened.
 */
export async function openApp($: EngineInterface, pluginRoot: string, cwd: string): Promise<boolean> {
  const root = pluginRoot.replace(/[\\/]+$/, '')
  try {
    const { exitCode, stdout } = await $.process.run(['node', `${root}/app/launch.js`, '--workdir', cwd], {
      timeoutMs: 120_000,
    })
    if (exitCode === 0) {
      $.ui.toast('Bridge opened', { timeoutMs: 3000 })
      return true
    }
    $.ui.toast(stdout.trim().split('\n').at(-1) || 'Bridge could not open', { timeoutMs: 10_000 })
  } catch {
    $.ui.toast('Bridge needs Node.js on PATH to open', { timeoutMs: 8000 })
  }
  return false
}
