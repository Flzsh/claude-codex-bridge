import { join } from 'node:path'

import type { PluginPaths } from './contracts'

export const pluginPaths: PluginPaths = pluginRoot => ({
  pluginRoot,
  runsDir: join(pluginRoot, 'runs'),
  settingsFile: join(pluginRoot, 'settings.json'),
  inboxDir: join(pluginRoot, 'inbox'),
  briefsDir: join(pluginRoot, 'app-briefs'),
  scriptsDir: join(pluginRoot, 'skills', 'codex-bridge'),
})
