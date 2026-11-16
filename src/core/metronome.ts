import type { TimeSignature } from './types'
import type { TempoMap } from './tempoMap'
import { MeterMap } from './meterMap'

/**
 * Metronome: app preferences, the click grid for a time signature, and the
 * engine-facing state. Clicks are monitor-only: engines add them after the
 * master bus, never to track inputs, recordings or WAV export.
 */
export type MetronomeSoundId = 'beep' | 'woodblock' | 'rim' | 'cowbell' | 'janggu' | 'buk' | 'bak' | 'kkwaenggwari' | 'moktak'
/** 0 = bar downbeat, 1 = group start (dotted quarter in 6/8, 9/8, 12/8), 2 = other pulses. */
export type MetronomeLevel = 0 | 1 | 2
export type CountInBars = 0 | 1 | 2

export interface MetronomeSoundInfo {
  id: MetronomeSoundId
  label: string
  family: 'classic' | 'gugak'
  /** What each level plays, for the popover hint. */
  strokes: readonly [string, string, string]
}

export const METRONOME_SOUNDS: readonly MetronomeSoundInfo[] = [
  { id: 'beep', label: '전자음', family: 'classic', strokes: ['높은 삐', '중간 삐', '삐'] },
  { id: 'woodblock', label: '우드블록', family: 'classic', strokes: ['높은 톡', '톡', '톡'] },
  { id: 'rim', label: '림 클릭', family: 'classic', strokes: ['강한 딱', '딱', '딱'] },
  { id: 'cowbell', label: '카우벨', family: 'classic', strokes: ['강한 땡', '땡', '짧은 땡'] },
  { id: 'janggu', label: '장구', family: 'gugak', strokes: ['덩', '쿵', '덕'] },
  { id: 'buk', label: '소리북', family: 'gugak', strokes: ['합(궁+딱)', '궁', '딱'] },
  { id: 'bak', label: '박', family: 'gugak', strokes: ['짝', '짝', '작은 짝'] },
  { id: 'kkwaenggwari', label: '꽹과리', family: 'gugak', strokes: ['갱', '개', '짓(막음)'] },
  { id: 'moktak', label: '목탁', family: 'gugak', strokes: ['강한 똑', '똑', '똑'] },
]
const SOUND_IDS = new Set<string>(METRONOME_SOUNDS.map(sound => sound.id))
export const isMetronomeSound = (value: unknown): value is MetronomeSoundId => typeof value === 'string' && SOUND_IDS.has(value)

export interface MetronomePrefs {
  enabled: boolean
  sound: MetronomeSoundId
  /** Linear click gain, 0–1 (UI shows percent). */
  volume: number
  /** Off plays every pulse with the plain beat stroke. */
  accent: boolean
  /** Bars of clicks before a recording that starts the transport. */
  countInBars: CountInBars
  /** Clicks only while recording (and its count-in). */
  recordOnly: boolean
}

/** What an engine needs; count-in clicks play even when `enabled` is false. */
export interface MetronomeEngineState {
  enabled: boolean
  sound: MetronomeSoundId
  volume: number
  accent: boolean
}

export interface PlayOptions {
  /** Click this many bars (at the project meter/tempo) before the transport starts. */
  countInBars?: number
}

export const DEFAULT_METRONOME_PREFS: Readonly<MetronomePrefs> = { enabled: false, sound: 'woodblock', volume: 0.7, accent: true, countInBars: 0, recordOnly: false }
export const METRONOME_STORAGE_KEY = 'garak-ieum:metronome:v1'

/** Field-by-field so older/partial or hand-edited preferences keep every valid value. */
export function normalizeMetronomePrefs(value: unknown): MetronomePrefs {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const d = DEFAULT_METRONOME_PREFS
  const volume = typeof raw.volume === 'number' && Number.isFinite(raw.volume) ? Math.min(1, Math.max(0, raw.volume)) : d.volume
  const countIn = raw.countInBars === 1 || raw.countInBars === 2 || raw.countInBars === 0 ? raw.countInBars : d.countInBars
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled,
    sound: isMetronomeSound(raw.sound) ? raw.sound : d.sound,
    volume,
    accent: typeof raw.accent === 'boolean' ? raw.accent : d.accent,
    countInBars: countIn,
    recordOnly: typeof raw.recordOnly === 'boolean' ? raw.recordOnly : d.recordOnly,
  }
}

export function loadMetronomePrefs(): MetronomePrefs {
  try { return normalizeMetronomePrefs(JSON.parse(localStorage.getItem(METRONOME_STORAGE_KEY) ?? 'null')) }
  catch { return { ...DEFAULT_METRONOME_PREFS } }
}

export function saveMetronomePrefs(prefs: MetronomePrefs): boolean {
  try { localStorage.setItem(METRONOME_STORAGE_KEY, JSON.stringify(normalizeMetronomePrefs(prefs))); return true }
  catch { return false }
}

/** Engine state for the current transport: "record only" mutes clicks outside recording. */
export function metronomeEngineState(prefs: MetronomePrefs, recordingActive: boolean): MetronomeEngineState {
  return { enabled: prefs.enabled && (!prefs.recordOnly || recordingActive), sound: prefs.sound, volume: prefs.volume, accent: prefs.accent }
}

// --- App-level store (useSyncExternalStore) ---
let current: MetronomePrefs | null = null
const listeners = new Set<() => void>()
export function getMetronomePrefs(): MetronomePrefs {
  if (!current) current = loadMetronomePrefs()
  return current
}
export function subscribeMetronomePrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
let lastCountIn: CountInBars = 1
/** ⇧K: count-in off, or back on at the last bar count used (1 bar the first time). */
export const toggledCountIn = (current: CountInBars, last: CountInBars): CountInBars => current > 0 ? 0 : last > 0 ? last : 1
export function toggleCountIn(): MetronomePrefs {
  return updateMetronomePrefs({ countInBars: toggledCountIn(getMetronomePrefs().countInBars, lastCountIn) })
}
export function updateMetronomePrefs(patch: Partial<MetronomePrefs>): MetronomePrefs {
  const next = normalizeMetronomePrefs({ ...getMetronomePrefs(), ...patch })
  if (next.countInBars > 0) lastCountIn = next.countInBars
  current = next
  saveMetronomePrefs(next)
  for (const listener of listeners) listener()
  return next
}

// --- Click grid ---
export interface MetronomeGrid {
  /** Quarter-note beats between clicks (the denominator's note value). */
  pulseBeats: number
  pulsesPerBar: number
  /** Pulses per accent group: 3 in compound meters (6/8, 9/8, 12/8, 6/16 …), else the whole bar. */
  groupPulses: number
}

export function isCompoundMeter(signature: TimeSignature): boolean {
  return signature.denominator >= 8 && signature.numerator > 3 && signature.numerator % 3 === 0
}

export function metronomeGrid(signature: TimeSignature): MetronomeGrid {
  return { pulseBeats: 4 / signature.denominator, pulsesPerBar: signature.numerator, groupPulses: isCompoundMeter(signature) ? 3 : signature.numerator }
}

export function pulseLevel(grid: MetronomeGrid, pulse: number): MetronomeLevel {
  const inBar = ((pulse % grid.pulsesPerBar) + grid.pulsesPerBar) % grid.pulsesPerBar
  if (inBar === 0) return 0
  return inBar % grid.groupPulses === 0 ? 1 : 2
}

export interface MetronomeClick { beat: number; pulse: number; level: MetronomeLevel }

const EPSILON = 1e-9
/** Clicks with startBeat <= beat < endBeat. Bars start at beat 0; the grid is in beats, so tempo changes never move it. */
export function clicksInRange(grid: MetronomeGrid, startBeat: number, endBeat: number): MetronomeClick[] {
  const clicks: MetronomeClick[] = []
  if (!(endBeat > startBeat) || !(grid.pulseBeats > 0)) return clicks
  let pulse = Math.max(0, Math.ceil(startBeat / grid.pulseBeats - EPSILON))
  for (let beat = pulse * grid.pulseBeats; beat < endBeat - EPSILON; pulse += 1, beat = pulse * grid.pulseBeats) {
    if (beat >= startBeat - EPSILON) clicks.push({ beat, pulse, level: pulseLevel(grid, pulse) })
  }
  return clicks
}

/**
 * Clicks with startBeat <= beat < endBeat across time-signature changes (docs/METER_MAP.md): each meter's
 * pulses restart on its first bar line, so the first pulse of every bar is the accented downbeat and compound
 * meters keep their dotted groups (겹박자) inside each bar. With one meter this equals clicksInRange.
 */
export function meterClicksInRange(meters: MeterMap, startBeat: number, endBeat: number): MetronomeClick[] {
  const clicks: MetronomeClick[] = []
  if (!(endBeat > startBeat)) return clicks
  const segments = meters.segments
  for (let index = meters.segmentAt(Math.max(0, startBeat)); index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment.beat >= endBeat - EPSILON) break
    const until = segments[index + 1]?.beat ?? Infinity
    const from = Math.max(startBeat, segment.beat)
    const to = Math.min(endBeat, until)
    for (const click of clicksInRange(metronomeGrid(segment), from - segment.beat, to - segment.beat)) clicks.push({ ...click, beat: click.beat + segment.beat })
  }
  return clicks
}

/** Quarter-note beats of a count-in: whole bars of `signature` (the meter where the transport starts). */
export function countInBeats(signature: TimeSignature, bars: number): number {
  const count = Number.isFinite(bars) ? Math.max(0, Math.min(4, Math.floor(bars))) : 0
  return count * signature.numerator * (4 / signature.denominator)
}

/** Count-in clicks, beats relative to the count-in start; the transport starts at the returned length. */
export function countInClicks(signature: TimeSignature, bars: number): { clicks: MetronomeClick[]; lengthBeats: number } {
  const lengthBeats = countInBeats(signature, bars)
  return { clicks: clicksInRange(metronomeGrid(signature), 0, lengthBeats), lengthBeats }
}

/** Applies the accent preference: with accent off every pulse uses the plain stroke. */
export const effectiveLevel = (level: MetronomeLevel, accent: boolean): MetronomeLevel => accent ? level : 2

/**
 * One transport segment of the realtime scheduler: [startBeat, endBeat) begins at `startTime` seconds.
 * `timing` is the project's tempo map (clicks follow its steps and ramps exactly) or a constant number
 * of seconds per beat. Returns audio-clock times.
 */
export function scheduleSegment(grid: MetronomeGrid | MeterMap, startBeat: number, endBeat: number, startTime: number, timing: number | TempoMap): Array<MetronomeClick & { time: number }> {
  const at = typeof timing === 'number' ? (beat: number) => (beat - startBeat) * timing : (beat: number) => timing.secondsBetween(startBeat, beat)
  const clicks = grid instanceof MeterMap ? meterClicksInRange(grid, startBeat, endBeat) : clicksInRange(grid, startBeat, endBeat)
  return clicks.map(click => ({ ...click, time: startTime + at(click.beat) }))
}
