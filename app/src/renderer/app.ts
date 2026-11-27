// The Bridge window: the live flow of You, Claude, Gemini and Codex, in the
// look the owner picked (CLI or drawn). It draws every animation frame from
// the clock and the flow's events; the main process sends the events and
// carries out the owner's answers.

import { CliView } from './flow/cli'
import { Flow, type BridgeApi, type Theme } from './flow/controller'
import { DrawnView } from './flow/drawn'

const bridge = (window as unknown as { bridge: BridgeApi }).bridge
const root = document.getElementById('app') as HTMLElement
const flow = new Flow(bridge)
// for the development capture (BRIDGE_SHOT_DIR): it opens screens the way a click would
;(window as unknown as { __bridgeFlow: Flow }).__bridgeFlow = flow

type View = { render(): void; destroy(): void }
let view: View | null = null
let theme: Theme | null = null

function show(next: Theme) {
  if (next === theme && view) return
  view?.destroy()
  theme = next
  document.documentElement.dataset.theme = next
  view = next === 'cli' ? new CliView(root, flow) : new DrawnView(root, flow)
}

let failures = 0
function loop() {
  try {
    const want = flow.settings?.theme ?? 'cli'
    if (want !== theme) show(want)
    view?.render()
    failures = 0
  } catch (error) {
    // One bad frame must not stop the window; a run of them is reported once.
    if (++failures === 30) console.error(error)
  }
  requestAnimationFrame(loop)
}

void flow.start().then(() => {
  show(flow.settings?.theme ?? 'cli')
  requestAnimationFrame(loop)
})
