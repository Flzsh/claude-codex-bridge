/** Builds the app in `here` when its build is older than its sources; see stale.cjs. */
export function buildIfStale(here: string, options?: { node?: string; env?: NodeJS.ProcessEnv; quiet?: boolean }): 'current' | 'built' | 'failed'
