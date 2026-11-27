// The step editor: each workflow size as a line of steps, the way the flow shows them. Click a
// step to set who does it, how much Codex takes, how many review rounds, and whether you review
// after it; add, move and remove steps. "Ask" stays first and "Check & ship" last. Every change is
// saved at once (main checks it against the rules and writes workflow.json); Claude follows the
// same steps through its skill (flow.sh steps), and the app, the companion and the sidebar show them.

import type { Lane, Size } from '../../../../core/console'
import type { Step, StepKind, Workflow } from '../../../../core/workflow'
import type { Flow } from './controller'

const SIZES: Size[] = ['small', 'medium', 'large']
const KINDS_TO_ADD: StepKind[] = ['plan', 'merge', 'decide', 'build', 'review']
const KIND_LABEL: Record<StepKind, string> = { ask: 'Ask', plan: 'Plan', merge: 'Merge', decide: 'Decide', build: 'Build', review: 'Review', ship: 'Check & ship' }
const NAME: Record<Lane, string> = { you: 'you', claude: 'claude', codex: 'codex', gemini: 'gemini' }
const LETTER: Record<Lane, string> = { you: 'y', claude: 'c', codex: 'x', gemini: 'g' }

/** Who may do a kind of step: [lane, can be switched, why not]. */
function choicesFor(kind: StepKind): [Lane, boolean, string][] {
  if (kind === 'ask' || kind === 'decide') return [['you', false, 'always you']]
  if (kind === 'ship') return [['claude', false, 'claude checks'], ['you', false, 'your yes to ship']]
  if (kind === 'plan') return [['claude', false, 'claude always plans'], ['gemini', true, ''], ['codex', true, '']]
  if (kind === 'merge') return [['claude', false, 'claude merges']]
  if (kind === 'build') return [['claude', true, ''], ['codex', true, ''], ['gemini', false, "can't edit files"]]
  return [['claude', true, ''], ['codex', true, ''], ['gemini', true, '']]
}

export class StepsEditor {
  private readonly el: HTMLElement
  private key = ''
  /** The step shown below the lines: [size, index]. */
  private chosen: [Size, number] | null = null
  private adding: Size | null = null
  /** The editor's own copy while saves are on their way, so quick edits build on each other. */
  private local: Workflow | null = null
  private saving = 0

  constructor(host: HTMLElement, private readonly flow: Flow, private readonly look: 'cli' | 'drawn') {
    this.el = document.createElement('div')
    this.el.className = `steps steps-${look}`
    this.el.hidden = true
    host.append(this.el)
    this.el.addEventListener('click', event => this.click(event))
    this.el.addEventListener('change', event => this.change(event))
    // Esc closes it, wherever the focus is
    document.addEventListener('keydown', this.onKey, true)
  }

  private readonly onKey = (event: KeyboardEvent) => {
    if (this.flow.stepsOpen && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.flow.closeSteps()
    }
  }

  destroy() {
    document.removeEventListener('keydown', this.onKey, true)
    this.el.remove()
  }

  /** What the editor shows and edits: its own copy while a save is under way, else main's. */
  private current(): Workflow | undefined {
    return this.saving > 0 && this.local ? this.local : this.flow.settings?.workflow
  }

  render() {
    const flow = this.flow
    const workflow = this.current()
    const open = flow.stepsOpen && Boolean(workflow)
    this.el.hidden = !open
    if (!open || !workflow) return
    const key = JSON.stringify([workflow, this.chosen, this.adding])
    if (key === this.key) return
    this.key = key
    this.el.innerHTML = this.html(workflow)
  }

  private html(workflow: Workflow): string {
    let out = `<div class="st-top"><span>${this.look === 'cli' ? '4:settings › steps' : 'Settings › Steps'}</span><button class="st-x" data-act="close">${this.look === 'cli' ? 'esc back' : 'Back'}</button></div><div class="st-body">`
    for (const size of SIZES) {
      const steps = workflow.sizes[size]
      out += `<div class="st-lane"><span class="st-sz">${size}</span><span class="st-line">`
      steps.forEach((step, i) => {
        const on = this.chosen?.[0] === size && this.chosen[1] === i
        const gate = step.kind === 'decide' || (step.gate && step.gate !== 'none')
        const others = step.who.filter(one => one !== step.who[0]).map(one => `<i class="w-${one}">·${LETTER[one]}</i>`).join('')
        if (i) out += '<span class="st-ln"></span>'
        out += `<button class="st-chip${on ? ' on' : ''}${gate ? ' gate' : ''}" data-act="pick" data-size="${size}" data-i="${i}"><span class="w-${step.who[0] ?? 'claude'}">${gate && step.kind === 'decide' ? '◉ ' : ''}${esc(step.label.toLowerCase())}</span>${others}${step.kind === 'review' && (step.rounds ?? 1) > 1 ? `<i class="st-n"> ${step.rounds}×</i>` : ''}${gate && step.kind !== 'decide' ? '<i class="st-g"> ◉</i>' : ''}</button>`
      })
      out += `</span><button class="st-add" data-act="add" data-size="${size}">+ step</button></div>`
      if (this.adding === size) {
        out += `<div class="st-menu"><span>add before “${esc(steps[steps.length - 1]?.label.toLowerCase() ?? 'check & ship')}”:</span>${KINDS_TO_ADD.map(kind => `<button class="st-opt" data-act="add-kind" data-size="${size}" data-kind="${kind}">${KIND_LABEL[kind].toLowerCase()}</button>`).join('')}${steps.length >= 9 ? '<span class="st-note">nine steps at most</span>' : ''}</div>`
      }
    }
    const chosen = this.chosen && workflow.sizes[this.chosen[0]][this.chosen[1]] ? this.chosen : null
    if (chosen) out += this.detail(workflow, chosen[0], chosen[1])
    out += `<div class="st-foot"><span>the steps here are the ones the app, the companion and the sidebar show; claude follows them through its skill</span><button class="st-opt" data-act="reset">reset to the defaults</button></div></div>`
    return out
  }

  private detail(workflow: Workflow, size: Size, i: number): string {
    const steps = workflow.sizes[size]
    const step = steps[i]!
    const end = step.kind === 'ask' || step.kind === 'ship'
    let out = `<div class="st-detail">`
    out += `<div class="st-kv"><span class="st-k">step</span><input class="st-label" data-act="label" maxlength="24" value="${esc(step.label)}" aria-label="The step's name"><span class="st-d">${size} · ${i + 1} of ${steps.length} · ${KIND_LABEL[step.kind].toLowerCase()}</span>`
    out += end ? `<span class="st-d st-right">${step.kind === 'ask' ? 'always first' : 'always last'}</span>` : `<span class="st-right"><button class="st-opt" data-act="move" data-by="-1"${i <= 1 ? ' disabled' : ''}>‹ move</button><button class="st-opt" data-act="move" data-by="1"${i >= steps.length - 2 ? ' disabled' : ''}>move ›</button><button class="st-opt st-del" data-act="remove">remove</button></span>`
    out += '</div>'
    out += `<div class="st-kv"><span class="st-k">who</span>${choicesFor(step.kind).map(([lane, free, why]) => {
      const on = step.who.includes(lane)
      return `<button class="st-who w-${lane}${on ? ' on' : ''}" data-act="who" data-lane="${lane}"${free ? '' : ' disabled'} title="${esc(why)}">${NAME[lane]} ${on ? '✓' : free ? '' : '✕'}${!free && why ? ` <i>${esc(why)}</i>` : ''}</button>`
    }).join('')}</div>`
    if (step.kind === 'build' && step.who.includes('codex')) {
      out += `<div class="st-kv"><span class="st-k">codex takes</span>${pick('codex', step.codex ?? 'one', [['one', 'one bounded block'], ['all', 'every backend block']])}</div>`
    }
    if (step.kind === 'review') out += `<div class="st-kv"><span class="st-k">rounds</span>${pick('rounds', String(step.rounds ?? 1), [['1', 'one'], ['2', 'two']])}</div>`
    if (!end && step.kind !== 'ask') {
      const options: [string, string][] = step.kind === 'decide' ? [['timed', 'carries on after the wait'], ['yes', 'needs your yes']] : [['none', 'none'], ['timed', 'carries on after the wait'], ['yes', 'needs your yes']]
      out += `<div class="st-kv"><span class="st-k">${step.kind === 'decide' ? 'you decide' : 'your review after it'}</span>${pick('gate', step.gate ?? (step.kind === 'decide' ? 'timed' : 'none'), options)}</div>`
    }
    return out + '</div>'
  }

  // ---------------------------------------------------------------- changes

  private click(event: MouseEvent) {
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (!el || (el as HTMLButtonElement).disabled) return
    const act = el.dataset.act
    const workflow = this.current()
    if (act === 'close') return this.flow.closeSteps()
    if (!workflow) return
    const size = (el.dataset.size as Size | undefined) ?? this.chosen?.[0]
    if (act === 'pick' && size) {
      const i = Number(el.dataset.i)
      this.chosen = this.chosen?.[0] === size && this.chosen[1] === i ? null : [size, i]
      this.adding = null
      return this.render()
    }
    if (act === 'add' && size) {
      this.adding = this.adding === size ? null : size
      return this.render()
    }
    if (act === 'add-kind' && size) {
      const kind = el.dataset.kind as StepKind
      const steps = workflow.sizes[size]
      if (steps.length >= 9) return
      const step: Step = { kind, label: KIND_LABEL[kind], who: kind === 'decide' ? ['you'] : kind === 'build' ? ['claude', 'codex'] : kind === 'review' ? ['codex'] : ['claude'], ...(kind === 'decide' ? { gate: 'timed' as const } : {}) }
      const at = steps.length - 1
      this.adding = null
      this.chosen = [size, at]
      return this.save(workflow, size, list => list.splice(at, 0, step))
    }
    if (act === 'reset') {
      this.chosen = null
      return void this.flow.resetWorkflow()
    }
    if (!this.chosen) return
    const [chosenSize, i] = this.chosen
    if (act === 'move') {
      const to = i + Number(el.dataset.by)
      this.chosen = [chosenSize, to]
      return this.save(workflow, chosenSize, list => list.splice(to, 0, ...list.splice(i, 1)))
    }
    if (act === 'remove') {
      this.chosen = null
      return this.save(workflow, chosenSize, list => list.splice(i, 1))
    }
    if (act === 'who') {
      const lane = el.dataset.lane as Lane
      return this.save(workflow, chosenSize, list => {
        const step = list[i]!
        const who = step.who.includes(lane) ? step.who.filter(one => one !== lane) : [...step.who, lane]
        // at least one does the step
        if (who.length) step.who = who
      })
    }
    if (act === 'set') {
      const field = el.dataset.field
      const value = el.dataset.value
      return this.save(workflow, chosenSize, list => {
        const step = list[i]!
        if (field === 'codex') step.codex = value === 'all' ? 'all' : 'one'
        if (field === 'rounds') step.rounds = value === '2' ? 2 : 1
        if (field === 'gate') step.gate = value === 'yes' ? 'yes' : value === 'timed' ? 'timed' : 'none'
      })
    }
  }

  private change(event: Event) {
    const el = event.target as HTMLInputElement
    if (el.dataset.act !== 'label' || !this.chosen) return
    const workflow = this.current()
    if (!workflow) return
    const label = el.value.trim().slice(0, 24)
    const [size, i] = this.chosen
    if (label) this.save(workflow, size, list => { list[i]!.label = label })
  }

  /** A copy with one size's steps changed, saved (main checks it and sends it back). */
  private save(workflow: Workflow, size: Size, edit: (steps: Step[]) => void) {
    const next = JSON.parse(JSON.stringify(workflow)) as Workflow
    edit(next.sizes[size])
    this.local = next
    this.saving++
    void this.flow.saveWorkflow(next).finally(() => {
      this.saving--
      if (this.saving === 0) this.local = null
      this.key = ''
      this.render()
    })
    this.key = ''
    this.render()
  }
}

/** A row of choices; the chosen one lit. */
function pick(field: string, current: string, options: [string, string][]): string {
  return options.map(([value, label]) => `<button class="st-opt${value === current ? ' on' : ''}" data-act="set" data-field="${field}" data-value="${value}">${esc(label)}</button>`).join('')
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
