// The drawn theme's hand: wobbly ink, washes laid just off the line, hatching,
// drawn shadows. No gradients, no glows, no blur. Shared by the flow and the
// companion. Every path is seeded by a key, so a thing is drawn the same way
// every frame and can grow without its line jumping.
//
// The window's CSP forbids style attributes in markup: geometry is set through
// element.style, and SVG uses presentation attributes only.

import type { Lane } from '../../../../core/flow'

export type Fill = Lane | 'gold' | 'manila' | 'oat' | 'clay' | 'sheet'
export const FILL: Record<Fill, string> = { you: '#c9d6df', claude: '#efc3ae', gemini: '#c9b6cc', codex: '#b7c0a0', gold: '#e2b865', manila: '#ebdbbc', oat: '#e3dacc', clay: '#e9a183', sheet: '#fffdf8' }
export const HATCH: Record<Fill, string> = { you: '#8fa6b6', claude: '#d08b6e', gemini: '#9a85a0', codex: '#869170', gold: '#b98a2f', manila: '#c8b083', oat: '#b9ab92', clay: '#c96442', sheet: '#d8d2c4' }
export const DEEP: Record<Lane, string> = { you: '#5d7a8f', claude: '#b8643f', gemini: '#7d6488', codex: '#5f6f45' }
export const NAME: Record<Lane, string> = { you: 'You', claude: 'Claude', gemini: 'Gemini', codex: 'Codex' }
export const INK = '#141413'
export const CLAY_UI = '#a9522f'
export const GHOST = '#a39f95'

// ---------------------------------------------------------------- the hand
let seed = 7
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
export const j = (n: number) => (rand() - 0.5) * 2 * n
export function seedFrom(text: string) {
  let h = 9
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 2147483646
  seed = h + 1
}

/** A closed hand-drawn rounded box. With `fixed`, the number of wobble points does not depend on size. */
export function boxPath(x: number, y: number, w: number, h: number, r: number, wob = 0.9, fixed: [number, number] | null = null): string {
  const pts: [number, number][] = []
  const corner = (cx: number, cy: number, a0: number) => {
    for (let k = 0; k <= 3; k++) {
      const a = a0 + (k / 3) * Math.PI / 2
      pts.push([cx + Math.cos(a) * r + j(wob * 0.5), cy + Math.sin(a) * r + j(wob * 0.5)])
    }
  }
  const edge = (x1: number, y1: number, x2: number, y2: number, along: 0 | 1) => {
    const n = fixed ? fixed[along] : Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 46))
    for (let k = 1; k < n; k++) pts.push([x1 + ((x2 - x1) * k) / n + j(wob), y1 + ((y2 - y1) * k) / n + j(wob)])
  }
  corner(x + w - r, y + r, -Math.PI / 2); edge(x + w, y + r, x + w, y + h - r, 1)
  corner(x + w - r, y + h - r, 0); edge(x + w - r, y + h, x + r, y + h, 0)
  corner(x + r, y + h - r, Math.PI / 2); edge(x, y + h - r, x, y + r, 1)
  corner(x + r, y + r, Math.PI); edge(x + r, y, x + w - r, y, 0)
  const first = pts[0] ?? [x, y]
  pts.push([first[0] + 4, first[1] + j(0.6)])
  let d = `M${first[0].toFixed(1)} ${first[1].toFixed(1)}`
  for (let k = 1; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1]
    if (!a || !b) continue
    d += ` Q${a[0].toFixed(1)} ${a[1].toFixed(1)} ${((a[0] + b[0]) / 2).toFixed(1)} ${((a[1] + b[1]) / 2).toFixed(1)}`
  }
  return d
}

/** A wobbly line; `n` fixes its number of points so it can stretch smoothly. */
export function linePath(x1: number, y1: number, x2: number, y2: number, wob = 0.8, step = 40, move = true, n: number | null = null): string {
  const count = n ?? Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / step))
  let d = move ? `M${x1.toFixed(1)} ${y1.toFixed(1)}` : ''
  for (let k = 1; k <= count; k++) {
    const x = x1 + ((x2 - x1) * k) / count + (k < count ? j(wob) : 0)
    const y = y1 + ((y2 - y1) * k) / count + (k < count ? j(wob) : 0)
    d += ` L${x.toFixed(1)} ${y.toFixed(1)}`
  }
  return d
}

export const NS = 'http://www.w3.org/2000/svg'
export const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))
export const ease = (k: number) => 1 - Math.pow(1 - k, 3)
export const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)
/** Text written in from the left: k from 0 (none) to 1 (all). */
export function wipe(el: HTMLElement | SVGElement, k: number) {
  el.style.clipPath = k >= 1 ? '' : `inset(-6px ${((1 - k) * 100).toFixed(1)}% -6px -4px)`
}
export const took = (s: number) => {
  const n = Math.max(0, Math.round(s))
  return n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, '0')}s`
}
export const elapsed = (s: number) => {
  const n = Math.max(0, Math.floor(s))
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}
export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
export const cap = (s: string | undefined | null) => (s ? s[0]!.toUpperCase() + s.slice(1) : '')

/** Positions an absolutely placed element (the CSP allows .style, not style attributes). */
export function place(el: HTMLElement | SVGElement, css: Partial<Record<'left' | 'top' | 'width' | 'height' | 'right' | 'bottom', number>>) {
  for (const [key, value] of Object.entries(css)) (el.style as unknown as Record<string, string>)[key] = `${value}px`
}

// ---------------------------------------------------------------- frames
export type FrameKind = 'card' | 'gate' | 'tag' | 'btn' | 'box'
export type Frame = {
  el: SVGSVGElement
  r: number
  key: string
  fill: Fill
  w: number
  h: number
  line: SVGPathElement
  wash: SVGPathElement
  shadow: SVGPathElement
  clip: SVGPathElement
  band: SVGPathElement | null
  run: SVGPathElement | null
  hatch: SVGPathElement[]
}

let clipId = 0
/** A drawn frame behind an element: shadow, wash, highlighter, hatching, the ink line, and (live) a line running round it. */
export function frame(host: HTMLElement, w: number, h: number, options: { fill: Fill; kind?: FrameKind; key: string; live?: boolean; runColor?: string }): Frame {
  const kind = options.kind ?? 'card'
  const r = kind === 'tag' || kind === 'btn' ? 6 : kind === 'box' ? 14 : 11
  const width = kind === 'tag' || kind === 'btn' ? 1.5 : 1.7
  const id = `ink-clip-${clipId++}`
  let s = `<clipPath id="${id}"><path class="f-clip"/></clipPath>`
  s += `<path class="f-shadow" fill="${INK}" fill-opacity="${kind === 'gate' ? 0.16 : 0.1}"/>`
  s += `<path class="f-wash" fill="${FILL[options.fill]}"/>`
  if (options.live) s += `<path class="f-band" clip-path="url(#${id})" fill="${HATCH[options.fill]}" opacity="0"/>`
  if (kind === 'card' || kind === 'gate') s += '<g class="f-hatch">' + '<path pathLength="1" stroke-width="1.3" stroke-linecap="round" fill="none"/>'.repeat(3) + '</g>'
  s += `<path class="f-line" pathLength="1" fill="none" stroke="${INK}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 1"/>`
  if (options.live) s += `<path class="f-run" pathLength="1" fill="none" stroke="${options.runColor ?? INK}" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="0.022 0.016" opacity="0"/>`
  const el = document.createElementNS(NS, 'svg')
  el.setAttribute('class', 'ink frame')
  el.innerHTML = s
  host.classList.add('framed')
  host.prepend(el)
  const pick = (selector: string) => el.querySelector(selector) as SVGPathElement
  const f: Frame = {
    el, r, key: options.key, fill: options.fill, w: 0, h: 0,
    line: pick('.f-line'), wash: pick('.f-wash'), shadow: pick('.f-shadow'), clip: pick('.f-clip'),
    band: el.querySelector('.f-band'), run: el.querySelector('.f-run'),
    hatch: [...el.querySelectorAll<SVGPathElement>('.f-hatch path')],
  }
  sizeFrame(f, w, h)
  return f
}

/** Redraws a frame at a new size with the same hand (same seed, same number of points). */
export function sizeFrame(f: Frame, width: number, height: number) {
  const w = Math.round(width), h = Math.round(height)
  if (f.w === w && f.h === h) return
  f.w = w
  f.h = h
  const fixed: [number, number] = [Math.max(2, Math.round(w / 46)), 2]
  f.el.setAttribute('width', String(w + 20))
  f.el.setAttribute('height', String(h + 20))
  f.el.setAttribute('viewBox', `-8 -8 ${w + 20} ${h + 20}`)
  seedFrom(f.key)
  f.shadow.setAttribute('d', boxPath(3, 3.5, w, h, f.r, 0.6, fixed))
  const washD = boxPath(1.3, 1.6, w - 1.5, h - 1.2, f.r, 0.5, fixed)
  f.wash.setAttribute('d', washD)
  f.clip.setAttribute('d', washD)
  f.hatch.forEach((p, k) => {
    const sx = w - 30 + k * 7 + j(1), sy = h - 7 + j(0.6)
    p.setAttribute('d', `M${sx.toFixed(1)} ${sy.toFixed(1)} l${(8 + j(1.5)).toFixed(1)} ${(-9 + j(1.5)).toFixed(1)}`)
    p.setAttribute('stroke', HATCH[f.fill])
  })
  f.line.setAttribute('d', boxPath(0, 0, w, h, f.r, 0.9, fixed))
  f.run?.setAttribute('d', boxPath(-5, -5, w + 10, h + 10, f.r + 4, 0.7, [fixed[0] + 1, 2]))
}

/** Draws a frame in: the line first, then the wash laid from just off it, then the hatching. */
export function setFrame(f: Frame, since: number, hatchLive = 0) {
  const k1 = ease(clamp(since / 0.5))
  const k2 = ease(clamp((since - 0.28) / 0.3))
  f.line.setAttribute('stroke-dashoffset', (1 - k1).toFixed(3))
  f.wash.setAttribute('opacity', k2.toFixed(3))
  f.wash.setAttribute('transform', `translate(${(-3 * (1 - k2)).toFixed(2)} ${(-3 * (1 - k2)).toFixed(2)})`)
  f.shadow.setAttribute('opacity', k2.toFixed(3))
  f.hatch.forEach((p, i) => {
    let k: number
    if (hatchLive) {
      // working: the three strokes are drawn over and over, like shading in progress
      const phase = (hatchLive * 1.1 + i * 0.22) % 1.3
      k = phase > 1.05 ? 0 : clamp(phase / 0.35)
    } else k = ease(clamp((since - 0.5 - i * 0.07) / 0.18))
    p.setAttribute('stroke-dasharray', '1 1')
    p.setAttribute('stroke-dashoffset', (1 - k).toFixed(3))
  })
}

/** The working look: an ink line running round the frame, and a highlighter stroke passing over it. */
export function setWorking(f: Frame, k: number, t: number) {
  if (!f.run || !f.band) return
  f.run.setAttribute('opacity', (k * 0.95).toFixed(3))
  f.run.setAttribute('stroke-dashoffset', (-(t * 0.09) % 1).toFixed(4))
  const x = ((t * 190) % (f.w + 150)) - 75
  seedFrom(f.key + 'band')
  const bw = 46, sk = 26
  f.band.setAttribute('d', `M${(x + j(1.5)).toFixed(1)} -4 L${(x + bw + j(1.5)).toFixed(1)} -4 L${(x + bw - sk + j(1.5)).toFixed(1)} ${f.h + 4} L${(x - sk + j(1.5)).toFixed(1)} ${f.h + 4} Z`)
  f.band.setAttribute('opacity', (k * 0.32).toFixed(3))
}

// ---------------------------------------------------------------- marks
/** Each agent's face: a drawn disc in its wash with its initial lettered in ink. The mark is the three agents joined. */
export function faceSvg(who: Lane | 'mark', size = 24): string {
  seedFrom('face' + who)
  if (who === 'mark') {
    return `<svg viewBox="0 0 32 30" width="${size}" height="${size - 2}"><path d="${linePath(16, 8.5, 23.5, 21.5, 0.5, 6)} ${linePath(23.5, 21.5, 8.5, 21.5, 0.5, 6, false)} ${linePath(8.5, 21.5, 16, 8.5, 0.5, 6, false)}" fill="none" stroke="${INK}" stroke-width="1.3" stroke-linecap="round"/><path d="${boxPath(11.8, 4.6, 8.4, 8.4, 4.2, 0.3)}" fill="${FILL.claude}" stroke="${INK}" stroke-width="1.4"/><path d="${boxPath(4.3, 17.3, 8.4, 8.4, 4.2, 0.3)}" fill="${FILL.codex}" stroke="${INK}" stroke-width="1.4"/><path d="${boxPath(19.3, 17.3, 8.4, 8.4, 4.2, 0.3)}" fill="${FILL.gemini}" stroke="${INK}" stroke-width="1.4"/></svg>`
  }
  const letter = { you: 'Y', claude: 'C', gemini: 'G', codex: 'X' }[who]
  return `<svg viewBox="0 0 30 30" width="${size}" height="${size}"><path d="${boxPath(4.5, 4.5, 21, 21, 10.5, 0.5)}" fill="${FILL[who]}"/><path d="${boxPath(3, 3, 21, 21, 10.5, 0.6)}" fill="none" stroke="${INK}" stroke-width="1.5"/><text x="13.6" y="18.4" text-anchor="middle" font-family="Literata, Georgia, serif" font-weight="700" font-size="12" fill="${INK}">${letter}</text></svg>`
}

/** Working: an ink loop being drawn round and round. */
export const loopSvg = (lane: Lane, t: number) =>
  `<circle cx="11" cy="11" r="7.2" fill="none" stroke="${FILL[lane]}" stroke-width="3"/><circle cx="11" cy="11" r="7.2" pathLength="1" fill="none" stroke="${INK}" stroke-width="1.7" stroke-linecap="round" stroke-dasharray="0.3 0.7" stroke-dashoffset="${(-((t * 0.85) % 1)).toFixed(3)}" transform="rotate(-90 11 11)"/>`

seedFrom('tick')
const TICK_RING = boxPath(2, 2, 18, 18, 9, 0.5)
/** Done: a ring and a tick, drawn in as k goes 0 to 1. */
export const tickSvg = (k = 1) =>
  `<path d="${TICK_RING}" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="${(1 - k).toFixed(3)}" fill="none" stroke="${INK}" stroke-width="1.3"/><path d="M6.4 11.4 9.6 14.6 15.8 7.4" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="${(1 - ease(clamp((k - 0.4) / 0.6))).toFixed(3)}" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
export const failSvg = () => `<path d="M6 6 16 16M16 6 6 16" stroke="${CLAY_UI}" stroke-width="1.8" stroke-linecap="round"/>`

seedFrom('clock')
const CLOCK_RING = boxPath(5, 5, 36, 36, 18, 0.5)
/** The review clock: the time left painted in gold, the seconds lettered in ink. */
export function clockSvg(left: string | number, frac: number): string {
  const a = -Math.PI / 2 + frac * Math.PI * 2, R = 17.5
  const wedge = frac >= 0.999
    ? `<circle cx="23" cy="23" r="${R}" fill="${FILL.gold}"/>`
    : frac <= 0.001 ? '' : `<path d="M23 23 L23 ${23 - R} A${R} ${R} 0 ${frac > 0.5 ? 1 : 0} 1 ${(23 + Math.cos(a) * R).toFixed(2)} ${(23 + Math.sin(a) * R).toFixed(2)} Z" fill="${FILL.gold}"/>`
  return `<path d="${CLOCK_RING}" fill="#fffdf8" transform="translate(1.2 1.4)"/>${wedge}<path d="${CLOCK_RING}" fill="none" stroke="${INK}" stroke-width="1.6"/><circle cx="23" cy="23" r="10.5" fill="#fffdf8"/><text x="23" y="27.4" text-anchor="middle" font-family="Literata, Georgia, serif" font-weight="700" font-size="12.5" fill="${INK}">${esc(left)}</text>`
}

/** A small drawn meter: hatched as far as the count has got, or a hatched block sweeping when it has no end. */
export function meterSvg(key: string, lane: Lane, meter: [number, number | null, string] | undefined, t: number, width = 128): string {
  seedFrom('meter' + key)
  const outline = boxPath(1, 2, width - 4, 9, 4.5, 0.4)
  const hatch = Array.from({ length: Math.ceil(width / 4.5) }, (_, k) => `M${(2 + k * 4.5 + j(0.4)).toFixed(1)} ${(11 + j(0.3)).toFixed(1)} l${(5 + j(0.6)).toFixed(1)} ${(-8 + j(0.5)).toFixed(1)}`).join(' ')
  const [n, of] = meter ?? [null, null]
  let fx = 2, fw: number
  if (of && n !== null) fw = (width - 6) * clamp(n / of)
  else {
    const ping = (t * 0.7) % 2, pos = ping < 1 ? ping : 2 - ping
    fw = Math.min(34, width / 3)
    fx = 2 + easeInOut(pos) * (width - 6 - fw)
  }
  const id = `meter-clip-${key.replace(/\W/g, '')}`
  return `<svg width="${width}" height="14" viewBox="0 0 ${width} 14"><clipPath id="${id}"><rect x="${fx.toFixed(1)}" y="0" width="${fw.toFixed(1)}" height="14"/></clipPath><path d="${outline}" fill="#fffdf8" fill-opacity=".6"/><g clip-path="url(#${id})"><path d="${outline}" fill="${FILL[lane]}"/><path d="${hatch}" stroke="${DEEP[lane]}" stroke-width="1.1" stroke-linecap="round" fill="none"/></g><path d="${outline}" fill="none" stroke="${INK}" stroke-width="1.2"/></svg>`
}
