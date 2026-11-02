/** Track color palette (Logic: 4 rows × 24 hues) tuned for the dark warm theme. */

export const PALETTE_COLUMNS = 24
export const PALETTE_ROWS = 4
/** Top → bottom: pastel, light, saturated, dark. Saturation stays under 65% so nothing turns neon on the dark theme. */
const ROW_SL: readonly [number, number][] = [[.45, .76], [.58, .62], [.62, .48], [.55, .34]]
const HUE_STEP = 360 / PALETTE_COLUMNS

/** Colors the demo project and instrument defs already use; they replace the nearest generated slot so old files hit the palette exactly. */
const LEGACY_COLORS = ['#e38457', '#7fb59a', '#6f9fd0', '#8cc7c0', '#d98a9f', '#d9b45a', '#c9a06a'] as const

export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const i = Math.floor((((h % 360) + 360) % 360) / 60)
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][i]
  return rgbToHex([r + m, g + m, b + m].map(v => Math.round(v * 255)) as [number, number, number])
}

const rgbToHex = ([r, g, b]: readonly [number, number, number]) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')

/** Parses #rgb or #rrggbb (case-insensitive); null for anything else. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const s = m[1].length === 3 ? m[1].split('').map(ch => ch + ch).join('') : m[1]
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}

/** Readable text for a user-owned track color; whiteMix matches an sRGB color-mix with white. */
export function contrastTextColor(hex: string, whiteMix = 0): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return 'var(--on-track-color)'
  const mix = Math.max(0, Math.min(1, whiteMix))
  const linear = rgb.map(value => {
    const channel = (value * (1 - mix) + 255 * mix) / 255
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
  })
  const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#000' : '#fff'
}

const normalizeHex = (hex: string): string | null => { const rgb = hexToRgb(hex); return rgb ? rgbToHex(rgb) : null }

export function rgbToHsl([r, g, b]: readonly [number, number, number]): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min, l = (max + min) / 2
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  return [h * 60, s, l]
}

const distance = (a: readonly [number, number, number], b: readonly [number, number, number]) => {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2]
  return dr * dr + dg * dg + db * db
}

/** Column from the color's hue, row from the closest (s, l) pair; falls back to the nearest free slot by RGB distance. */
function legacySlot(hex: string, palette: readonly string[], taken: Set<number>): number {
  const rgb = hexToRgb(hex)!
  const [h, s, l] = rgbToHsl(rgb)
  const col = Math.round(h / HUE_STEP) % PALETTE_COLUMNS
  let row = 0, rowDist = Infinity
  ROW_SL.forEach(([rs, rl], i) => { const d = (rs - s) ** 2 + (rl - l) ** 2; if (d < rowDist) { rowDist = d; row = i } })
  const slot = row * PALETTE_COLUMNS + col
  if (!taken.has(slot)) return slot
  let best = -1, bestDist = Infinity
  palette.forEach((color, i) => {
    if (taken.has(i)) return
    const d = distance(rgb, hexToRgb(color)!)
    if (d < bestDist) { bestDist = d; best = i }
  })
  return best
}

function buildPalette(): string[] {
  const out: string[] = []
  for (const [s, l] of ROW_SL) for (let i = 0; i < PALETTE_COLUMNS; i++) out.push(hslToHex(i * HUE_STEP, s, l))
  const taken = new Set<number>()
  for (const legacy of LEGACY_COLORS) {
    const slot = legacySlot(legacy, out, taken)
    out[slot] = legacy
    taken.add(slot)
  }
  return out
}

/** 96 colors, row-major: index = row × 24 + hueIndex (hue = hueIndex × 15°, 0 = red). */
export const TRACK_PALETTE: readonly string[] = buildPalette()

export const paletteSlot = (row: number, hueIndex: number) => TRACK_PALETTE[row * PALETTE_COLUMNS + hueIndex]

/** Logic defaults: audio tracks blue, software-instrument tracks green (second row). */
export function defaultTrackColor(kind: 'instrument' | 'audio', _instrumentCategory?: string): string {
  return kind === 'audio' ? paletteSlot(1, 210 / HUE_STEP) : paletteSlot(1, 120 / HUE_STEP)
}

/** Index in TRACK_PALETTE, or -1 when the color is not an exact member. */
export function paletteIndex(hex: string): number {
  const norm = normalizeHex(hex)
  return norm ? TRACK_PALETTE.indexOf(norm) : -1
}

/** Exact member when possible, otherwise the closest palette color; unparsable input falls back to the instrument default. */
export function nearestPaletteColor(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return defaultTrackColor('instrument')
  const exact = paletteIndex(hex)
  if (exact >= 0) return TRACK_PALETTE[exact]
  let best = TRACK_PALETTE[0], bestDist = Infinity
  for (const color of TRACK_PALETTE) {
    const d = distance(rgb, hexToRgb(color)!)
    if (d < bestDist) { bestDist = d; best = color }
  }
  return best
}
