import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clicksInRange, countInBeats, countInClicks, DEFAULT_METRONOME_PREFS, getMetronomePrefs, isCompoundMeter, METRONOME_STORAGE_KEY, metronomeEngineState,
  metronomeGrid, normalizeMetronomePrefs, scheduleSegment, updateMetronomePrefs,
} from './metronome'

const levels = (signature: { numerator: number; denominator: 2 | 4 | 8 | 16 }, start: number, end: number) =>
  clicksInRange(metronomeGrid(signature), start, end).map(click => [click.beat, click.level])

describe('metronome click grid', () => {
  it('clicks every quarter in 4/4 with the bar downbeat accented', () => {
    expect(levels({ numerator: 4, denominator: 4 }, 0, 8)).toEqual([[0, 0], [1, 2], [2, 2], [3, 2], [4, 0], [5, 2], [6, 2], [7, 2]])
  })

  it('groups compound meters in dotted quarters', () => {
    expect(isCompoundMeter({ numerator: 6, denominator: 8 })).toBe(true)
    expect(isCompoundMeter({ numerator: 3, denominator: 8 })).toBe(false)
    expect(levels({ numerator: 6, denominator: 8 }, 0, 3)).toEqual([[0, 0], [0.5, 2], [1, 2], [1.5, 1], [2, 2], [2.5, 2]])
    const twelve = levels({ numerator: 12, denominator: 8 }, 0, 6).filter(([, level]) => level !== 2)
    expect(twelve).toEqual([[0, 0], [1.5, 1], [3, 1], [4.5, 1]])
    // Simple meters with other units: 2/2 clicks half notes, 7/8 eighths with only the downbeat accented.
    expect(levels({ numerator: 2, denominator: 2 }, 0, 8)).toEqual([[0, 0], [2, 2], [4, 0], [6, 2]])
    expect(levels({ numerator: 7, denominator: 8 }, 0, 3.5).filter(([, level]) => level !== 2)).toEqual([[0, 0]])
  })

  it('uses half-open ranges so adjacent scheduler segments never double or drop a click', () => {
    const grid = metronomeGrid({ numerator: 4, denominator: 4 })
    const whole = clicksInRange(grid, 0, 16).map(click => click.beat)
    const edges = [0, 0.37, 1, 2.999999, 3, 7.5, 8, 16]
    const pieces = edges.slice(1).flatMap((end, index) => clicksInRange(grid, edges[index], end).map(click => click.beat))
    expect(pieces).toEqual(whole)
    expect(clicksInRange(grid, 1.000001, 2)).toEqual([])
    expect(clicksInRange(grid, 0.9999999999, 1.5).map(click => click.beat)).toEqual([1])
  })

  it('maps segments onto the audio clock, following tempo and loop wraps', () => {
    const grid = metronomeGrid({ numerator: 4, denominator: 4 })
    // 120 BPM: beat 1.5-4 starting at t=10 s.
    expect(scheduleSegment(grid, 1.5, 4, 10, 0.5).map(click => [click.beat, click.time])).toEqual([[2, 10.25], [3, 10.75]])
    // Tempo change: same beats at 60 BPM are twice as far apart.
    expect(scheduleSegment(grid, 1.5, 4, 10, 1).map(click => click.time)).toEqual([10.5, 11.5])
    // Loop 2-6 wrapping: the engine schedules [4.5, 6) then [2, 3.5); the loop start (beat 2) clicks once per pass.
    const before = scheduleSegment(grid, 4.5, 6, 0, 0.5)
    const after = scheduleSegment(grid, 2, 3.5, 0.75, 0.5)
    expect(before.map(click => [click.beat, click.level, click.time])).toEqual([[5, 2, 0.25]])
    expect(after.map(click => [click.beat, click.time])).toEqual([[2, 0.75], [3, 1.25]])
  })

  it('counts in whole bars of the project meter', () => {
    expect(countInBeats({ numerator: 4, denominator: 4 }, 2)).toBe(8)
    expect(countInBeats({ numerator: 6, denominator: 8 }, 1)).toBe(3)
    expect(countInBeats({ numerator: 4, denominator: 4 }, 0)).toBe(0)
    const { clicks, lengthBeats } = countInClicks({ numerator: 3, denominator: 4 }, 2)
    expect(lengthBeats).toBe(6)
    expect(clicks.map(click => click.level)).toEqual([0, 2, 2, 0, 2, 2])
  })
})

describe('metronome preferences', () => {
  const saved = new Map<string, string>()
  beforeEach(() => { saved.clear(); vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) }) })
  afterEach(() => vi.unstubAllGlobals())

  it('survives storage that throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } })
    expect(updateMetronomePrefs({ volume: 0.3 }).volume).toBe(0.3)
  })

  it('normalizes partial, older or corrupt values field by field', () => {
    expect(normalizeMetronomePrefs(null)).toEqual(DEFAULT_METRONOME_PREFS)
    expect(normalizeMetronomePrefs({ enabled: true, sound: 'janggu', volume: 3, countInBars: 7, extra: 1 }))
      .toEqual({ ...DEFAULT_METRONOME_PREFS, enabled: true, sound: 'janggu', volume: 1 })
    expect(normalizeMetronomePrefs({ sound: 'gong', accent: 'yes', recordOnly: true, countInBars: 2 }))
      .toEqual({ ...DEFAULT_METRONOME_PREFS, recordOnly: true, countInBars: 2 })
  })

  it('persists updates as an app preference', () => {
    updateMetronomePrefs({ enabled: true, sound: 'kkwaenggwari', countInBars: 1 })
    expect(JSON.parse(localStorage.getItem(METRONOME_STORAGE_KEY) ?? '{}')).toMatchObject({ enabled: true, sound: 'kkwaenggwari', countInBars: 1 })
    expect(getMetronomePrefs().sound).toBe('kkwaenggwari')
    updateMetronomePrefs({ enabled: false })
  })

  it('mutes clicks outside recording when "record only" is set', () => {
    const prefs = { ...DEFAULT_METRONOME_PREFS, enabled: true, recordOnly: true }
    expect(metronomeEngineState(prefs, false).enabled).toBe(false)
    expect(metronomeEngineState(prefs, true).enabled).toBe(true)
    expect(metronomeEngineState({ ...prefs, recordOnly: false }, false).enabled).toBe(true)
  })
})
