import { describe, expect, it } from 'vitest'
import { TempoMap, addTempoPoint, deleteTempoPoint, moveTempoPoint, normalizeTempoPoints, setTempoAt, setTempoCurve, spanBeats, spanSeconds, tempoMapOf, tempoPointsFromSteps, tempoStepsForExport, withTempoPoints } from './tempoMap'
import { createEmptyProject, validateProject } from './project'
import { clicksInRange, metronomeGrid, scheduleSegment } from './metronome'
import { parseMidiFile } from './midiImport'
import { writeMidiFile } from './midiExport'
import { createTrack } from './project'
import type { Project, TempoPoint } from './types'
import { positionAfter } from '../audio/math'
import { compensatedBeat, frameToBeat, heardTransportBeat } from './midiRecording'
import { recordingPlacement } from './recordingOffset'
import { splitClip, trimClipStart } from './project'
import { audioWindows, midiEvents } from './playback'

const ramp = (from: number, to: number, beats: number): TempoPoint[] => [{ beat: 0, bpm: from, curve: 'ramp' }, { beat: beats, bpm: to, curve: 'step' }]

/** Numerical integral of 60 / bpm(b) db (midpoint rule) as an independent reference. */
function integrate(map: TempoMap, from: number, to: number, steps = 200_000): number {
  const h = (to - from) / steps
  let sum = 0
  for (let i = 0; i < steps; i += 1) sum += 60 / map.bpmAt(from + (i + 0.5) * h)
  return sum * h
}

describe('tempo map conversion', () => {
  it('is linear for a constant tempo', () => {
    const map = new TempoMap(120)
    expect(map.isConstant).toBe(true)
    expect(map.secondsAt(8)).toBe(4)
    expect(map.beatAt(3)).toBe(6)
    expect(map.secondsAt(-2)).toBe(-1)
  })

  it('steps hold each tempo until the next point', () => {
    const map = new TempoMap(120, [{ beat: 0, bpm: 120, curve: 'step' }, { beat: 4, bpm: 60, curve: 'step' }, { beat: 8, bpm: 240, curve: 'step' }])
    expect(map.secondsAt(4)).toBeCloseTo(2, 12)
    expect(map.secondsAt(8)).toBeCloseTo(6, 12)
    expect(map.secondsAt(12)).toBeCloseTo(7, 12)
    expect(map.bpmAt(3.999)).toBe(120)
    expect(map.bpmAt(4)).toBe(60)
    expect(map.beatAt(6.5)).toBeCloseTo(10, 12)
    expect(map.bpmAt(100)).toBe(240)
  })

  it('integrates ramps exactly (60/k · ln(v1/v0))', () => {
    const map = new TempoMap(90, ramp(90, 150, 8))
    const exact = 60 / ((150 - 90) / 8) * Math.log(150 / 90)
    expect(map.secondsAt(8)).toBeCloseTo(exact, 12)
    expect(map.secondsAt(8)).toBeCloseTo(integrate(map, 0, 8), 7)
    expect(map.secondsAt(5)).toBeCloseTo(integrate(map, 0, 5), 7)
    expect(map.bpmAt(4)).toBeCloseTo(120, 12)
    // After the ramp the target tempo holds.
    expect(map.secondsBetween(8, 12)).toBeCloseTo(4 * 60 / 150, 12)
  })

  it('handles slowing ramps and tiny slopes without losing precision', () => {
    const down = new TempoMap(160, ramp(160, 70, 16))
    expect(down.secondsAt(16)).toBeCloseTo(integrate(down, 0, 16), 7)
    const tiny = new TempoMap(120, ramp(120, 120.000001, 4))
    expect(tiny.secondsAt(4)).toBeCloseTo(4 * 60 / 120.0000005, 12)
  })

  it('round-trips beats → seconds → beats across steps and ramps', () => {
    const map = new TempoMap(100, [
      { beat: 0, bpm: 100, curve: 'ramp' }, { beat: 6, bpm: 180, curve: 'step' }, { beat: 10, bpm: 75, curve: 'ramp' }, { beat: 18.5, bpm: 75.5, curve: 'ramp' }, { beat: 30, bpm: 210, curve: 'step' },
    ])
    for (let beat = -2; beat <= 40; beat += 0.37) {
      expect(map.beatAt(map.secondsAt(beat))).toBeCloseTo(beat, 9)
    }
    for (let seconds = 0; seconds <= 20; seconds += 0.29) {
      expect(map.secondsAt(map.beatAt(seconds))).toBeCloseTo(seconds, 9)
    }
  })

  it('normalizes points: sorted, first at beat 0 with the project tempo, duplicates replaced', () => {
    expect(normalizeTempoPoints(110, [{ beat: 8, bpm: 140, curve: 'step' }, { beat: 0, bpm: 99, curve: 'ramp' }, { beat: 8, bpm: 150, curve: 'ramp' }, { beat: -1, bpm: 50, curve: 'step' }]))
      .toEqual([{ beat: 0, bpm: 110, curve: 'ramp' }, { beat: 8, bpm: 150, curve: 'ramp' }])
    expect(normalizeTempoPoints(500, [])).toEqual([{ beat: 0, bpm: 300, curve: 'step' }])
  })

  it('accepts a number or a map wherever clips convert beats', () => {
    const map = new TempoMap(60, [{ beat: 0, bpm: 60, curve: 'step' }, { beat: 2, bpm: 120, curve: 'step' }])
    expect(spanSeconds(120, 1, 3)).toBe(1)
    expect(spanSeconds(map, 1, 3)).toBeCloseTo(1.5, 12)
    expect(spanBeats(map, 1, 1.5)).toBeCloseTo(2, 12)
  })
})

describe('tempo map editing', () => {
  const base = (): Project => ({ ...createEmptyProject(), bpm: 100 })

  it('adds, moves, deletes and toggles points, keeping Project.bpm the first tempo', () => {
    let project = addTempoPoint(base(), 8, 140)
    expect(project.tempoMap).toEqual([{ beat: 0, bpm: 100, curve: 'step' }, { beat: 8, bpm: 140, curve: 'step' }])
    project = setTempoCurve(project, 0, 'ramp')
    expect(tempoMapOf(project).bpmAt(4)).toBeCloseTo(120, 12)
    project = moveTempoPoint(project, 1, 12, 160)
    expect(project.tempoMap![1]).toEqual({ beat: 12, bpm: 160, curve: 'step' })
    project = moveTempoPoint(project, 0, 5, 90)
    expect(project.bpm).toBe(90)
    expect(project.tempoMap![0]).toEqual({ beat: 0, bpm: 90, curve: 'ramp' })
    project = deleteTempoPoint(project, 1)
    expect(project.tempoMap).toBeUndefined()
    expect(project.bpm).toBe(90)
  })

  it('keeps a dragged point between its neighbours', () => {
    let project = addTempoPoint(addTempoPoint(base(), 4, 120), 8, 140)
    project = moveTempoPoint(project, 1, 20, 120)
    expect(project.tempoMap![1].beat).toBeLessThan(8)
    expect(project.tempoMap!.map(point => point.beat)).toEqual([...project.tempoMap!.map(point => point.beat)].sort((a, b) => a - b))
  })

  it('edits the header tempo at the playhead: Project.bpm without a map, the point at or before the playhead with one', () => {
    expect(setTempoAt(base(), 10, 130)).toMatchObject({ bpm: 130 })
    expect(setTempoAt(base(), 10, 130).tempoMap).toBeUndefined()
    const mapped = addTempoPoint(base(), 8, 140)
    expect(setTempoAt(mapped, 9, 150).tempoMap![1].bpm).toBe(150)
    expect(setTempoAt(mapped, 7.99, 80)).toMatchObject({ bpm: 80 })
    expect(setTempoAt(mapped, 7.99, 80).tempoMap![1].bpm).toBe(140)
  })

  it('caches the compiled map per tempo-map array', () => {
    const project = addTempoPoint(base(), 8, 140)
    expect(tempoMapOf(project)).toBe(tempoMapOf({ ...project }))
    expect(tempoMapOf(base())).toBe(tempoMapOf({ bpm: 100 }))
  })
})

describe('schema 14 tempo map persistence', () => {
  it('round-trips a tempo map and loads schema ≤ 13 files with a constant tempo', () => {
    const project = withTempoPoints({ ...createEmptyProject(), bpm: 90 }, ramp(90, 150, 8))
    const loaded = validateProject(JSON.parse(JSON.stringify(project)))
    expect(loaded.schemaVersion).toBe(createEmptyProject().schemaVersion)
    expect(loaded.tempoMap).toEqual(ramp(90, 150, 8))
    const legacy = validateProject({ ...JSON.parse(JSON.stringify(project)), schemaVersion: 13 })
    expect(legacy.tempoMap).toBeUndefined()
    expect(legacy.bpm).toBe(90)
    expect(validateProject(JSON.parse(JSON.stringify(createEmptyProject()))).tempoMap).toBeUndefined()
  })

  it('rejects malformed tempo maps', () => {
    const project = JSON.parse(JSON.stringify(withTempoPoints({ ...createEmptyProject(), bpm: 90 }, ramp(90, 150, 8))))
    expect(() => validateProject({ ...project, tempoMap: [{ beat: 0, bpm: 91, curve: 'step' }, { beat: 4, bpm: 100, curve: 'step' }] })).toThrow(/project tempo/)
    expect(() => validateProject({ ...project, tempoMap: [{ beat: 0, bpm: 90, curve: 'step' }, { beat: 0, bpm: 100, curve: 'step' }] })).toThrow(/sorted/)
    expect(() => validateProject({ ...project, tempoMap: [{ beat: 0, bpm: 90, curve: 'linear' }] })).toThrow(/curve/)
    expect(() => validateProject({ ...project, tempoMap: [{ beat: 0, bpm: 90, curve: 'step' }, { beat: 4, bpm: 400, curve: 'step' }] })).toThrow(/tempo/)
    expect(() => validateProject({ ...project, schemaVersion: createEmptyProject().schemaVersion + 1 })).toThrow(/version/)
  })
})

describe('metronome across a tempo map', () => {
  it('places every click at its exact time through a ramp', () => {
    const map = new TempoMap(90, ramp(90, 150, 8))
    const grid = metronomeGrid({ numerator: 4, denominator: 4 })
    const clicks = scheduleSegment(grid, 0, 12, 10, map)
    expect(clicks.map(click => click.beat)).toEqual(clicksInRange(grid, 0, 12).map(click => click.beat))
    for (const click of clicks) expect(click.time).toBeCloseTo(10 + integrate(map, 0, click.beat, 20_000), 6)
    // Intervals shrink through the accelerando, then hold at 150 BPM.
    const gaps = clicks.slice(1).map((click, index) => click.time - clicks[index].time)
    for (let index = 1; index < 8; index += 1) expect(gaps[index]).toBeLessThan(gaps[index - 1])
    expect(gaps[10]).toBeCloseTo(0.4, 12)
    // A segment starting mid-ramp agrees with the whole-range schedule.
    const later = scheduleSegment(grid, 3.5, 12, 10 + map.secondsAt(3.5), map)
    expect(later.map(click => click.time)).toEqual(clicks.filter(click => click.beat >= 3.5).map(click => expect.closeTo(click.time, 9)))
  })
})

describe('SMF tempo import/export', () => {
  const midiProject = (tempoMap: TempoPoint[], bpm = tempoMap[0].bpm): Project => {
    const track = { ...createTrack('instrument'), clips: [{ id: 'c', kind: 'midi' as const, name: 'm', startBeat: 0, lengthBeats: 16, gain: 1, notes: [{ id: 'n', pitch: 60, start: 0, duration: 1, velocity: 0.8 }] }] }
    return withTempoPoints({ ...createEmptyProject(), bpm, lengthBeats: 16, tracks: [track] }, tempoMap)
  }

  it('writes steps as single tempo events and reads them back exactly', () => {
    const map: TempoPoint[] = [{ beat: 0, bpm: 120, curve: 'step' }, { beat: 4, bpm: 96, curve: 'step' }, { beat: 10, bpm: 150, curve: 'step' }]
    const events = tempoStepsForExport(new TempoMap(120, map), 960)
    expect(events).toEqual([{ tick: 0, microseconds: 500_000 }, { tick: 3840, microseconds: 625_000 }, { tick: 9600, microseconds: 400_000 }])
    expect(parseMidiFile(writeMidiFile(midiProject(map))).tempoMap).toEqual(map)
  })

  it('writes ramps as 32nd-note steps whose boundaries keep exact time, and imports them as a ramp again', () => {
    const map = new TempoMap(90, ramp(90, 150, 8))
    const events = tempoStepsForExport(map, 960)
    expect(events).toHaveLength(8 * 8 + 1)
    // Elapsed time through the stepped events matches the ramp at every step boundary (µs rounding only).
    let seconds = 0
    for (let index = 0; index + 1 < events.length; index += 1) {
      seconds += (events[index + 1].tick - events[index].tick) / 960 * events[index].microseconds / 1e6
      expect(seconds).toBeCloseTo(map.secondsAt(events[index + 1].tick / 960), 5)
    }
    const parsed = parseMidiFile(writeMidiFile(midiProject(ramp(90, 150, 8))))
    expect(parsed.bpm).toBeCloseTo(90, 1)
    const imported = parsed.tempoMap!
    expect(imported).toHaveLength(2)
    expect(imported[0]).toMatchObject({ beat: 0, curve: 'ramp' })
    expect(imported[0].bpm).toBeCloseTo(90, 1)
    expect(imported[1]).toEqual({ beat: 8, bpm: 150, curve: 'step' })
  })

  it('keeps irregular tempo events as steps', () => {
    const points = tempoPointsFromSteps([{ beat: 0, bpm: 120 }, { beat: 1, bpm: 121 }, { beat: 2, bpm: 140 }, { beat: 3, bpm: 100 }, { beat: 4, bpm: 128 }])
    expect(points.every(point => point.curve === 'step')).toBe(true)
    expect(points).toHaveLength(5)
  })
})

describe('transport, recording and clips through a tempo map', () => {
  const project = (): Project => withTempoPoints({ ...createEmptyProject(), bpm: 90, lengthBeats: 16, loop: { enabled: false, startBeat: 0, endBeat: 16 } }, ramp(90, 150, 8))
  const map = () => tempoMapOf(project())

  it('moves the playhead along the map and wraps a cycle by its real duration', () => {
    const p = project()
    expect(positionAfter(p, 0, map().secondsAt(6))).toBeCloseTo(6, 9)
    expect(positionAfter(p, 2, map().secondsBetween(2, 7))).toBeCloseTo(7, 9)
    const looped = { ...p, loop: { enabled: true, startBeat: 4, endBeat: 12 } }
    const cycle = map().secondsBetween(4, 12)
    expect(positionAfter(looped, 4, cycle + map().secondsBetween(4, 5))).toBeCloseTo(5, 9)
    expect(heardTransportBeat(looped, 4, 10, 10 + 2 * cycle + map().secondsBetween(4, 9))).toBeCloseTo(9, 9)
  })

  it('converts native frames, latency and recordings through the map', () => {
    expect(frameToBeat(110470, 48000, map())).toBeCloseTo(4, 4)
    expect(compensatedBeat(4, map().secondsBetween(3, 4), map())).toBeCloseTo(3, 9)
    const placement = recordingPlacement(2, map(), map().secondsBetween(2, 10), 0)!
    expect(placement.startBeat).toBeCloseTo(2, 9)
    expect(placement.lengthBeats).toBeCloseTo(8, 9)
  })

  it('splits and trims audio at the real source time of the cut', () => {
    const clip = { id: 'a', kind: 'audio' as const, name: 'a', startBeat: 0, lengthBeats: 12, gain: 1, assetId: 'x', offsetSeconds: 0, fadeIn: 0, fadeOut: 0 }
    const [, right] = splitClip(clip, 6, map()) as [typeof clip, typeof clip]
    expect(right.offsetSeconds).toBeCloseTo(map().secondsAt(6), 12)
    expect((trimClipStart(clip, 4, map()) as typeof clip).offsetSeconds).toBeCloseTo(map().secondsAt(4), 12)
    expect(audioWindows({ ...createTrack('audio'), clips: [clip] }, 16, map())).toHaveLength(1)
    // MIDI stays in beats: notes are scheduled at their beats and only the engines convert to time.
    expect(midiEvents({ ...createTrack('instrument'), clips: [{ id: 'm', kind: 'midi', name: 'm', startBeat: 0, lengthBeats: 4, gain: 1, notes: [{ id: 'n', pitch: 60, start: 2, duration: 1, velocity: 1 }] }] }, 16)[0].start).toBe(2)
  })
})
