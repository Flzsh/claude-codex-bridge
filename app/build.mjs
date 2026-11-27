// Builds the app with esbuild: the main process and preload for Node (CommonJS),
// the window's script for the browser, and the static files beside it.
// `node build.mjs --tests` also bundles test/*.spec.ts into dist-test/ for `node --test`.
import { build } from 'esbuild'
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const here = import.meta.dirname
const dist = join(here, 'dist')
const common = { bundle: true, sourcemap: 'linked', logLevel: 'warning', target: 'es2023', tsconfig: join(here, 'tsconfig.json') }

const testsOnly = process.argv.includes('--tests-only')
if (!testsOnly) await buildApp()
if (testsOnly || process.argv.includes('--tests')) await buildTests()

async function buildApp() {
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

await build({
  ...common,
  entryPoints: { main: join(here, 'src/main/main.ts'), preload: join(here, 'src/main/preload.ts') },
  outdir: dist,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
})

await build({
  ...common,
  entryPoints: { renderer: join(here, 'src/renderer/app.ts'), companion: join(here, 'src/renderer/companion.ts') },
  outdir: dist,
  platform: 'browser',
  format: 'iife',
})

for (const file of ['index.html', 'styles.css', 'companion.html', 'companion.css']) cpSync(join(here, 'src/renderer', file), join(dist, file))
// The serif, from the OFL-licensed @fontsource package: nothing is fetched at run time.
const fonts = join(here, 'node_modules/@fontsource-variable/literata/files')
mkdirSync(join(dist, 'fonts'), { recursive: true })
for (const name of ['literata-latin-wght-normal.woff2', 'literata-latin-wght-italic.woff2']) {
  cpSync(join(fonts, name), join(dist, 'fonts', name))
}
// Written last: launch.js treats the build as current only when this exists.
writeFileSync(join(dist, '.complete'), new Date().toISOString())
}

async function buildTests() {
  const out = join(here, 'dist-test')
  rmSync(out, { recursive: true, force: true })
  const tests = readdirSync(join(here, 'test')).filter(name => name.endsWith('.spec.ts'))
  await build({
    ...common,
    entryPoints: tests.map(name => join(here, 'test', name)),
    outdir: out,
    outExtension: { '.js': '.mjs' },
    platform: 'node',
    format: 'esm',
    external: ['electron'],
  })
}
