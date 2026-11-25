// A terminal screen on a canvas, drawn the way terminals draw:
// - a fixed grid of cells, each glyph centred in its own cell (a glyph much wider than a cell is scaled to fit),
// - box-drawing characters drawn as lines, so they join across cells and rows without gaps,
// - graph nodes drawn as shapes, so they sit exactly on the lane line,
// - only the rows that changed since the last frame are repainted.

export const U = 1
export const D = 2
export const L = 4
export const R = 8

type BoxStyle = 'light' | 'round' | 'dash3' | 'dash2' | 'heavy' | 'hook'
const BOX: Record<string, { bits: number; style: BoxStyle }> = {}
function addBox(chars: string, bits: number, style: BoxStyle = 'light') {
  for (const ch of chars) BOX[ch] = { bits, style }
}
addBox('─', L | R); addBox('│', U | D)
addBox('┌', D | R); addBox('┐', D | L); addBox('└', U | R); addBox('┘', U | L)
addBox('├', U | D | R); addBox('┤', U | D | L); addBox('┬', L | R | D); addBox('┴', L | R | U); addBox('┼', U | D | L | R)
addBox('╭', D | R, 'round'); addBox('╮', D | L, 'round'); addBox('╰', U | R, 'round'); addBox('╯', U | L, 'round')
addBox('╴', L); addBox('╶', R); addBox('╵', U); addBox('╷', D)
addBox('┄', L | R, 'dash3'); addBox('┆', U | D, 'dash3'); addBox('╌', L | R, 'dash2'); addBox('╎', U | D, 'dash2')
addBox('━', L | R, 'heavy'); addBox('┃', U | D, 'heavy')
addBox('⎿', U | R, 'hook')

const NODE: Record<string, 'dot' | 'ring' | 'target' | 'diamond'> = { '●': 'dot', '◉': 'target', '◇': 'diamond', '○': 'ring' }

/** The character for a set of sides (rounded corners, like the panes). */
export const JOIN: Record<number, string> = {
  [U | D]: '│', [L | R]: '─', [D | R]: '╭', [D | L]: '╮', [U | R]: '╰', [U | L]: '╯',
  [U | D | R]: '├', [U | D | L]: '┤', [L | R | D]: '┬', [L | R | U]: '┴', [U | D | L | R]: '┼',
  [U]: '│', [D]: '│', [L]: '─', [R]: '─',
}

export type Cell = { c: string; fg: string; bg: string | null; b: boolean; u: boolean }
export type PutOptions = { max?: number; bg?: string | null; b?: boolean; u?: boolean }
export type Color = string | ((index: number) => string)

export type TermOptions = {
  font?: string
  size?: number
  lineHeight?: number
  bg: string
  fg: string
  /** A fixed size in CSS pixels; otherwise the canvas's own box. */
  width?: number
  height?: number
  pad?: number
}

export class Term {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly fontFamily: string
  private readonly size: number
  readonly bg: string
  readonly fg: string
  private readonly pad: number
  private fixed: { width: number; height: number } | null
  dpr = 1
  cw = 8
  readonly ch: number
  cols = 0
  rows = 0
  ox = 0
  oy = 0
  cells: Cell[][] = []
  private painted: (string | null)[] = []
  private readonly widths = new Map<string, number>()
  private cssWidth = 0
  private cssHeight = 0

  constructor(canvas: HTMLCanvasElement, options: TermOptions) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('No 2D canvas')
    this.ctx = ctx
    this.fontFamily = options.font ?? "'Cascadia Mono', 'Cascadia Code', Consolas, monospace"
    this.size = options.size ?? 14
    this.ch = options.lineHeight ?? 18
    this.bg = options.bg
    this.fg = options.fg
    this.pad = options.pad ?? 8
    this.fixed = options.width && options.height ? { width: options.width, height: options.height } : null
    this.resize()
  }

  /** Sizes the grid to the canvas (or the fixed size); call again when the box changes. */
  resize(width?: number, height?: number) {
    if (width && height) this.fixed = { width, height }
    const box = this.canvas.getBoundingClientRect()
    const w = this.fixed?.width ?? Math.max(1, Math.floor(box.width))
    const h = this.fixed?.height ?? Math.max(1, Math.floor(box.height))
    this.dpr = window.devicePixelRatio || 1
    if (w === this.cssWidth && h === this.cssHeight && this.cells.length) return
    this.cssWidth = w
    this.cssHeight = h
    this.canvas.width = Math.round(w * this.dpr)
    this.canvas.height = Math.round(h * this.dpr)
    if (this.fixed) {
      this.canvas.style.width = `${w}px`
      this.canvas.style.height = `${h}px`
    }
    this.ctx.font = `${this.size}px ${this.fontFamily}`
    // Like a terminal: the cell width snaps to whole device pixels.
    this.cw = Math.round(this.ctx.measureText('M').width * this.dpr) / this.dpr
    this.cols = Math.max(1, Math.floor((w - this.pad * 2) / this.cw))
    this.rows = Math.max(1, Math.floor((h - this.pad) / this.ch))
    this.ox = Math.floor((w - this.cols * this.cw) / 2)
    this.oy = Math.floor((h - this.rows * this.ch) / 2)
    this.cells = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => ({ c: ' ', fg: this.fg, bg: null, b: false, u: false })))
    this.painted = new Array<string | null>(this.rows).fill(null)
    this.widths.clear()
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.ctx.fillStyle = this.bg
    this.ctx.fillRect(0, 0, w, h)
  }

  clear() {
    for (const row of this.cells) for (const cell of row) { cell.c = ' '; cell.fg = this.fg; cell.bg = null; cell.b = false; cell.u = false }
  }

  /** Writes text from (x, y); stops at `max` (exclusive column); returns the column after it. */
  put(x: number, y: number, text: string, fg: Color = this.fg, options: PutOptions = {}): number {
    const row = this.cells[y]
    if (!row) return x
    const max = Math.min(options.max ?? this.cols, this.cols)
    let i = 0
    for (const ch of text) {
      const col = x + i
      i++
      if (col < 0) continue
      if (col >= max) break
      const cell = row[col]
      if (!cell) continue
      cell.c = ch
      cell.fg = typeof fg === 'function' ? fg(i - 1) : fg
      if (options.bg !== undefined) cell.bg = options.bg
      cell.b = Boolean(options.b)
      cell.u = Boolean(options.u)
    }
    return x + i
  }

  cell(x: number, y: number): Cell | undefined {
    return this.cells[y]?.[x]
  }

  shade(x: number, y: number, w: number, bg: string) {
    const row = this.cells[y]
    if (!row) return
    for (let i = Math.max(0, x); i < Math.min(this.cols, x + w); i++) {
      const cell = row[i]
      if (cell) cell.bg = bg
    }
  }

  box(x: number, y: number, w: number, h: number, fg: string) {
    this.put(x, y, '╭' + '─'.repeat(Math.max(0, w - 2)) + '╮', fg)
    for (let r = 1; r < h - 1; r++) { this.put(x, y + r, '│', fg); this.put(x + w - 1, y + r, '│', fg) }
    this.put(x, y + h - 1, '╰' + '─'.repeat(Math.max(0, w - 2)) + '╯', fg)
  }

  /** The cell under a point in CSS pixels relative to the canvas, or null. */
  at(px: number, py: number): { x: number; y: number } | null {
    const x = Math.floor((px - this.ox) / this.cw)
    const y = Math.floor((py - this.oy) / this.ch)
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows ? { x, y } : null
  }

  private glyphWidth(ch: string, bold: boolean): number {
    const key = (bold ? 'b' : '') + ch
    let w = this.widths.get(key)
    if (w === undefined) {
      this.ctx.font = `${bold ? 'bold ' : ''}${this.size}px ${this.fontFamily}`
      w = this.ctx.measureText(ch).width
      this.widths.set(key, w)
    }
    return w
  }

  paint() {
    const ctx = this.ctx
    const { cw, ch, ox, oy } = this
    for (let y = 0; y < this.rows; y++) {
      const row = this.cells[y]
      if (!row) continue
      let key = ''
      for (const cell of row) key += cell.c + cell.fg + (cell.bg ?? '') + (cell.b ? 'B' : '') + (cell.u ? 'U' : '') + '|'
      if (this.painted[y] === key) continue
      this.painted[y] = key
      const top = oy + y * ch
      ctx.fillStyle = this.bg
      ctx.fillRect(0, top, this.cssWidth, ch)
      for (let x = 0; x < this.cols; x++) {
        const bg = row[x]?.bg
        if (!bg) continue
        let end = x
        while (end + 1 < this.cols && row[end + 1]?.bg === bg) end++
        ctx.fillStyle = bg
        ctx.fillRect(ox + x * cw, top, (end - x + 1) * cw, ch)
        x = end
      }
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'
      let font = ''
      for (let x = 0; x < this.cols; x++) {
        const cell = row[x]
        if (!cell || (cell.c === ' ' && !cell.u)) continue
        const left = ox + x * cw
        if (BOX[cell.c]) { this.drawBox(cell.c, left, top, cell.fg); continue }
        if (NODE[cell.c]) { this.drawNode(cell.c, left, top, cell.fg); continue }
        if (cell.c !== ' ') {
          const want = `${cell.b ? 'bold ' : ''}${this.size}px ${this.fontFamily}`
          if (want !== font) { ctx.font = want; font = want }
          ctx.fillStyle = cell.fg
          const w = this.glyphWidth(cell.c, cell.b)
          const cx = left + cw / 2, cy = top + ch / 2 + 0.5
          if (w > cw * 1.6) {
            const s = Math.max(cw / w, 0.72)
            ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s); ctx.fillText(cell.c, 0, 0); ctx.restore()
          } else ctx.fillText(cell.c, cx, cy)
        }
        if (cell.u) { ctx.fillStyle = cell.fg; ctx.fillRect(left, top + ch - 3, cw, 1) }
      }
    }
  }

  private snap(v: number): number {
    return (Math.floor(v * this.dpr) + 0.5) / this.dpr
  }

  private drawBox(c: string, left: number, top: number, color: string) {
    const ctx = this.ctx
    const { cw, ch, dpr } = this
    const box = BOX[c]
    if (!box) return
    const { bits, style } = box
    const cx = this.snap(left + cw / 2), cy = this.snap(top + ch / 2)
    const right = left + cw, bottom = top + ch
    ctx.strokeStyle = color
    ctx.lineWidth = ((style === 'heavy' ? 2 : 1) / dpr) * Math.max(1, Math.round(dpr))
    ctx.setLineDash(style === 'dash3' ? (bits & (L | R) ? [2, 2] : [3, 3]) : style === 'dash2' ? [3, 3] : [])
    ctx.lineCap = 'butt'
    ctx.beginPath()
    if (style === 'round') {
      const r = Math.min(cw, ch) / 2
      const hx = bits & R ? right : left
      const vy = bits & D ? bottom : top
      ctx.moveTo(hx, cy)
      ctx.arcTo(cx, cy, cx, vy, r)
      ctx.lineTo(cx, vy)
    } else if (style === 'hook') {
      // Claude Code's result hook: a short corner low in the cell.
      const x = this.snap(left + cw * 0.35)
      ctx.moveTo(x, top + 1)
      ctx.lineTo(x, cy)
      ctx.lineTo(right, cy)
    } else {
      if (bits & L) { ctx.moveTo(left, cy); ctx.lineTo(cx, cy) }
      if (bits & R) { ctx.moveTo(cx, cy); ctx.lineTo(right, cy) }
      if (bits & U) { ctx.moveTo(cx, top); ctx.lineTo(cx, cy) }
      if (bits & D) { ctx.moveTo(cx, cy); ctx.lineTo(cx, bottom) }
    }
    ctx.stroke()
    ctx.setLineDash([])
  }

  private drawNode(c: string, left: number, top: number, color: string) {
    const ctx = this.ctx
    const cx = this.snap(left + this.cw / 2), cy = this.snap(top + this.ch / 2)
    ctx.fillStyle = color
    ctx.strokeStyle = color
    ctx.lineWidth = 1.3
    ctx.beginPath()
    const kind = NODE[c]
    if (kind === 'dot') { ctx.arc(cx, cy, 3.6, 0, Math.PI * 2); ctx.fill() }
    else if (kind === 'ring') { ctx.arc(cx, cy, 3.4, 0, Math.PI * 2); ctx.stroke() }
    else if (kind === 'target') { ctx.arc(cx, cy, 4.8, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(cx, cy, 2.2, 0, Math.PI * 2); ctx.fill() }
    else if (kind === 'diamond') { ctx.moveTo(cx, cy - 4.5); ctx.lineTo(cx + 4, cy); ctx.lineTo(cx, cy + 4.5); ctx.lineTo(cx - 4, cy); ctx.closePath(); ctx.stroke() }
  }
}
