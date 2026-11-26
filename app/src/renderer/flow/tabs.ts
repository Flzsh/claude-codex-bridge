// The window's tabs, like a browser's: one per workflow, in whatever folder it runs, and this
// folder when nothing of it runs. Each says how its workflow stands (working, waiting for you,
// paused, done) and where it runs. The terminal look draws them in the title bar; the drawn look
// in its top bar, as paper tabs.

import { boxPath, seedFrom } from '../../../../core/paint'
import type { Flow, TabInfo } from './controller'
import { INK } from './ink'
import { C, spin } from './termkit'

type Item = { el: HTMLElement; mark: HTMLElement; tab: TabInfo }

export class TabStrip {
  private readonly el: HTMLElement
  private items: Item[] = []
  private key = ''

  constructor(host: HTMLElement, private readonly flow: Flow, private readonly look: 'cli' | 'drawn') {
    this.el = document.createElement('div')
    this.el.className = `tabs tabs-${look}`
    host.append(this.el)
  }

  destroy() {
    this.el.remove()
  }

  /** Builds the strip when the tabs change; every frame, turns the marks of working tabs. */
  render(t: number) {
    const tabs = this.flow.tabs
    const key = JSON.stringify(tabs)
    if (key !== this.key) {
      this.key = key
      this.build(tabs)
    }
    if (this.look === 'cli') for (const item of this.items) if (item.tab.mark === 'work') item.mark.textContent = spin('claude', t)
  }

  private build(tabs: TabInfo[]) {
    this.el.replaceChildren()
    this.items = []
    tabs.forEach((tab, i) => {
      const el = document.createElement('div')
      el.className = `tab m-${tab.mark}${tab.active ? ' on' : ''}`
      el.title = `${tab.title}\n${tab.workdir}`
      if (this.look === 'drawn') el.append(this.paper(tab, i))
      const mark = span('mk', this.glyph(tab))
      if (this.look === 'cli') mark.style.color = TAB_COLOURS[tab.mark]
      el.append(mark, span('tt', tab.title))
      // the folder, where it says something the title does not
      if (tab.flow !== null) el.append(span('fd', tab.folder))
      if (tab.flow !== null) {
        const close = document.createElement('button')
        close.className = 'x'
        close.textContent = '×'
        close.title = 'Hide this tab: the workflow keeps running (Ctrl+Shift+T brings it back)'
        close.addEventListener('click', event => {
          event.stopPropagation()
          this.flow.closeTab(tab.key)
        })
        el.append(close)
      }
      el.addEventListener('click', () => {
        if (!tab.active) this.flow.selectTab(tab.key)
      })
      // a middle click closes, as in a browser
      el.addEventListener('auxclick', event => {
        if (event.button === 1 && tab.flow !== null) this.flow.closeTab(tab.key)
      })
      this.el.append(el)
      this.items.push({ el, mark, tab })
    })
  }

  private glyph(tab: TabInfo): string {
    if (tab.mark === 'wait') return '◉'
    if (tab.mark === 'pause') return '‖'
    if (tab.mark === 'done') return '✓'
    if (tab.mark === 'quiet') return '·'
    if (tab.mark === 'idle') return this.look === 'cli' ? '◇' : '○'
    return this.look === 'cli' ? spin('claude', 0) : '●'
  }

  /** The drawn look's tab: a sheet of paper with a hand-drawn edge, its top corners round. */
  private paper(tab: TabInfo, i: number): SVGSVGElement {
    seedFrom(`tab-${tab.key}-${i}`)
    const fill = tab.active ? '#faf9f5' : tab.mark === 'wait' ? '#f3e3bf' : '#ece8de'
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'paper')
    svg.setAttribute('viewBox', '0 0 200 40')
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.innerHTML = `<path d="${boxPath(1.5, 2, 197, 52, 9, 0.5)}" fill="${fill}" stroke="${INK}" stroke-width="1.3" vector-effect="non-scaling-stroke"/>`
    return svg
  }
}

/** The tab keys, as in a browser: Ctrl+Tab and Ctrl+Shift+Tab, Ctrl+1..9, Ctrl+W. True when one was used. */
export function tabKey(event: KeyboardEvent, flow: Flow): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false
  if (event.shiftKey && event.key.toLowerCase() === 't') {
    event.preventDefault()
    flow.reopenTab()
    return true
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    flow.nextTab(event.shiftKey ? -1 : 1)
    return true
  }
  if (/^[1-9]$/.test(event.key)) {
    event.preventDefault()
    flow.tabAt(Number(event.key) - 1)
    return true
  }
  if (event.key.toLowerCase() === 'w') {
    event.preventDefault()
    const shown = flow.tabs.find(tab => tab.active)
    if (shown?.flow) flow.closeTab(shown.key)
    return true
  }
  return false
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = className
  el.textContent = text
  return el
}

/** The terminal look's colour for a tab's mark. */
export const TAB_COLOURS = { work: C.claude, wait: C.amber, pause: C.amber, done: C.green, quiet: C.faint, idle: C.dim }
