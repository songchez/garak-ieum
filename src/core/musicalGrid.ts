/** Shared visual rhythm grid. Display detail follows zoom; the editing snap stays independent. */
export interface MusicalGrid {
  ppb: number
  beatsPerBar: number
  barBeats: number
  beatBeats: number
  subdivisionBeats: number
  stepBeats: number
}

const closeToInteger = (value: number) => Math.abs(value - Math.round(value)) < 1e-7

export function musicalGrid(ppb: number, { snap = 0, beatsPerBar = 4, minSpacing = 10 }: { snap?: number; beatsPerBar?: number; minSpacing?: number } = {}): MusicalGrid {
  ppb = Number.isFinite(ppb) && ppb > 0 ? ppb : 30
  beatsPerBar = Number.isFinite(beatsPerBar) && beatsPerBar > 0 ? beatsPerBar : 4
  minSpacing = Number.isFinite(minSpacing) && minSpacing > 0 ? minSpacing : 10
  const barBeats = beatsPerBar * Math.max(1, 2 ** Math.ceil(Math.log2(minSpacing / (ppb * beatsPerBar))))
  const beatBeats = ppb >= minSpacing ? 1 : 0
  const inverse = 2 / snap
  const triplet = snap > 0 && snap < 1 && closeToInteger(inverse) && Math.round(inverse) % 3 === 0
  let subdivisionBeats = 0
  for (let division = 2; division <= 128; division *= 2) {
    const step = (triplet ? 2 / 3 : 1) / division
    if (step * ppb < minSpacing - 1e-7) break
    subdivisionBeats = step
  }
  return { ppb, beatsPerBar, barBeats, beatBeats, subdivisionBeats, stepBeats: subdivisionBeats || beatBeats || barBeats }
}

/** CSS repeating layers keep long arrangements independent of the number of grid divisions. */
export function musicalGridStyle(grid: MusicalGrid): { backgroundImage: string; backgroundSize: string } {
  const layers: [number, string][] = [[grid.barBeats, 'var(--grid-major)']]
  if (grid.beatBeats) layers.push([grid.beatBeats, 'var(--grid-minor)'])
  if (grid.subdivisionBeats) layers.push([grid.subdivisionBeats, 'color-mix(in srgb,var(--grid-minor) 75%,transparent)'])
  return {
    backgroundImage: layers.map(([, color]) => `linear-gradient(to right,${color} 1px,transparent 1px)`).join(','),
    backgroundSize: layers.map(([beats]) => `${beats * grid.ppb}px 100%`).join(','),
  }
}

export interface MusicalRulerMark { beat: number; kind: 'bar' | 'beat' | 'subdivision'; label: string }

/** Only request the visible interval. The cap also protects unusual imported lengths and scales. */
export function musicalRulerMarks(grid: MusicalGrid, startBeat: number, endBeat: number, maxMarks = 512): MusicalRulerMark[] {
  if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || endBeat < startBeat) return []
  const start = Math.max(0, startBeat), end = Math.max(start, endBeat), cap = Math.max(1, Math.floor(maxMarks))
  let step = grid.stepBeats
  while (Math.ceil((end - start) / step) + 2 > cap && Number.isFinite(step * 2)) step *= 2
  const marks: MusicalRulerMark[] = []
  const first = Math.max(0, Math.floor(start / step)), last = Math.ceil(end / step)
  const barLabelStep = grid.beatsPerBar * Math.max(1, 2 ** Math.ceil(Math.log2(42 / (grid.ppb * grid.beatsPerBar))))
  for (let index = first; index <= last && marks.length < cap; index++) {
    const beat = index * step, bar = Math.floor((beat + 1e-7) / grid.beatsPerBar) + 1
    const isBar = closeToInteger(beat / grid.beatsPerBar), isBeat = closeToInteger(beat)
    const kind = isBar ? 'bar' : isBeat ? 'beat' : 'subdivision'
    let label = ''
    if (isBar && closeToInteger(beat / barLabelStep)) label = String(bar)
    else if (isBeat && grid.ppb >= 48) label = `${bar}.${Math.round(beat % grid.beatsPerBar) + 1}`
    else if (!isBeat && step * grid.ppb >= 48) label = `${bar}.${Math.floor(beat % grid.beatsPerBar) + 1}.${Math.round((beat % 1) / step) + 1}`
    marks.push({ beat, kind, label })
  }
  return marks
}

/** Shared endpoints, with no visual padding that would turn adjacent regions into apparent gaps. */
export function musicalSpan(start: number, duration: number, ppb: number): { left: number; width: number } {
  const left = start * ppb
  return { left, width: Math.max(0, (start + duration) * ppb - left) }
}
