import { describe, expect, it } from 'vitest'
import { ProjectSession } from './ProjectSession'
import { setProjectTimeSignature } from './meter'
import {
  MeterMap, addMeterEvent, deleteMeterEvent, hasMeterChanges, meterEventsForExport, meterEventsFromSmf, meterMapOf, moveMeterEvent,
  normalizeMeterEvents, setMeterEvent, withMeterEvents,
} from './meterMap'
import { clicksInRange, countInClicks, meterClicksInRange, metronomeGrid, scheduleSegment } from './metronome'
import { meterGridStyle, meterRulerMarks, musicalGrid, musicalRulerMarks } from './musicalGrid'
import { createEmptyProject, createTrack, validateProject } from './project'
import { TempoMap, tempoMapOf, withTempoPoints } from './tempoMap'
import { writeMidiFile } from './midiExport'
import { parseMidiFile } from './midiImport'
import { planMediaImport } from './mediaImport'
import { compileNativeTimeline } from '../audio/native/timeline'
import { PROJECT_SCHEMA_VERSION, type MeterEvent, type MidiClip, type Project } from './types'

/** 4/4 (bar 1) → 3/4 (bar 2) → 7/8 (bar 3) → 6/8 (bar 4 onwards). Bar lines at beats 0, 4, 7, 10.5, 13.5, 16.5 … */
const EVENTS: MeterEvent[] = [
  { bar: 0, numerator: 4, denominator: 4 }, { bar: 1, numerator: 3, denominator: 4 },
  { bar: 2, numerator: 7, denominator: 8 }, { bar: 3, numerator: 6, denominator: 8 },
]
const songMap = () => new MeterMap({ numerator: 4, denominator: 4 }, EVENTS)
const song = (): Project => withMeterEvents({ ...createEmptyProject(), bpm: 120 }, EVENTS)

describe('meter map conversions', () => {
  it('walks bars into quarter-note beats and back', () => {
    const map = songMap()
    expect(map.segments.map(segment => [segment.bar, segment.beat, segment.barBeats, segment.beatUnit])).toEqual([[0, 0, 4, 1], [1, 4, 3, 1], [2, 7, 3.5, .5], [3, 10.5, 3, .5]])
    expect([0, 1, 2, 3, 4, 5].map(bar => map.beatAtBar(bar))).toEqual([0, 4, 7, 10.5, 13.5, 16.5])
    expect(map.beatAtBar(2.5)).toBe(8.75)
    for (let beat = -3; beat < 30; beat += .37) expect(map.beatAtBar(map.barAt(beat))).toBeCloseTo(beat, 9)
    expect(map.barAt(-4)).toBe(-1)
    expect(map.meterAt(8)).toEqual({ numerator: 7, denominator: 8 })
    expect(map.meterAt(10.5)).toEqual({ numerator: 6, denominator: 8 })
    expect(map.isConstant).toBe(false)
    expect(new MeterMap({ numerator: 3, denominator: 4 }, [{ bar: 0, numerator: 3, denominator: 4 }, { bar: 4, numerator: 3, denominator: 4 }]).isConstant).toBe(true)
  })

  it('reports bar.beat positions in each bar\'s own denominator', () => {
    const map = songMap()
    expect(map.position(0)).toEqual({ bar: 1, beat: 1, fraction: 0, meter: { numerator: 4, denominator: 4 } })
    expect(map.position(6.5)).toMatchObject({ bar: 2, beat: 3, fraction: .5 })
    // 7/8: eighth-note beats.
    expect(map.position(7)).toMatchObject({ bar: 3, beat: 1 })
    expect(map.position(10)).toMatchObject({ bar: 3, beat: 7, fraction: 0 })
    expect(map.position(10.25)).toMatchObject({ bar: 3, beat: 7, fraction: .5 })
    expect(map.position(12)).toMatchObject({ bar: 4, beat: 4, meter: { numerator: 6, denominator: 8 } })
    expect(map.position(13.5)).toMatchObject({ bar: 5, beat: 1 })
  })

  it('finds bar lines for navigation, cycles and lengths', () => {
    const map = songMap()
    expect(map.barStart(9)).toBe(7)
    expect(map.barStart(10.5)).toBe(10.5)
    expect(map.nextBarStart(7)).toBe(10.5)
    expect(map.nextBarStart(6.99)).toBe(7)
    expect(map.previousBarStart(7)).toBe(4)
    expect(map.previousBarStart(7.1)).toBe(7)
    expect(map.ceilBarStart(7.1)).toBe(10.5)
    expect(map.ceilBarStart(7)).toBe(7)
    expect(map.nearestBarStart(8.7)).toBe(7)
    expect(map.nearestBarStart(8.8)).toBe(10.5)
    expect(map.beatsForBars(4, 2)).toBe(6.5)
    expect(map.barsCovering(11)).toBe(4)
  })

  it('snaps finer grids relative to each meter\'s first bar line', () => {
    const map = songMap()
    // A quarter grid after the 7/8 bar (which starts on beat 7 and ends on 10.5) lands on 10.5 + n.
    expect(map.snap(11.4, 1)).toBe(11.5)
    expect(map.snap(8.2, 1)).toBe(8)
    // Near a change the change itself wins over a grid point past it.
    expect(map.snap(10.4, 1)).toBe(10.5)
    // One meter: plain rounding.
    expect(MeterMap.constant({ numerator: 4, denominator: 4 }).snap(5.3, .5)).toBe(5.5)
  })

  it('converts bars to seconds through the tempo map', () => {
    const project = withTempoPoints(song(), [{ beat: 0, bpm: 120, curve: 'step' }, { beat: 7, bpm: 60, curve: 'step' }])
    const meters = meterMapOf(project), tempo = tempoMapOf(project)
    // Bar 4 (index 3) starts at beat 10.5: 7 beats at 120 BPM + 3.5 beats at 60 BPM.
    expect(tempo.secondsAt(meters.beatAtBar(3))).toBeCloseTo(3.5 + 3.5, 9)
    expect(meters.barAt(tempo.beatAt(7))).toBeCloseTo(3, 9)
  })
})

describe('meter map normalization and editing', () => {
  it('normalizes: the first event carries the project meter, invalid entries drop, the last duplicate wins', () => {
    expect(normalizeMeterEvents({ numerator: 5, denominator: 4 }, [
      { bar: 4, numerator: 3, denominator: 4 }, { bar: 0, numerator: 9, denominator: 8 }, { bar: 2, numerator: 0, denominator: 4 },
      { bar: 2, numerator: 6, denominator: 16 as never }, { bar: 1.5, numerator: 3, denominator: 4 }, { bar: 4, numerator: 2, denominator: 2 },
      { bar: 3, numerator: 7, denominator: 3 as never },
    ])).toEqual([{ bar: 0, numerator: 5, denominator: 4 }, { bar: 2, numerator: 6, denominator: 16 }, { bar: 4, numerator: 2, denominator: 2 }])
  })

  it('adds, edits, moves (between neighbours) and deletes changes as plain project edits', () => {
    let project = addMeterEvent(createEmptyProject(), 4, 3, 4)
    project = addMeterEvent(project, 8, 7, 8)
    expect(project.meterMap).toEqual([{ bar: 0, numerator: 4, denominator: 4 }, { bar: 4, numerator: 3, denominator: 4 }, { bar: 8, numerator: 7, denominator: 8 }])
    expect(hasMeterChanges(project)).toBe(true)
    expect(meterMapOf(project).beatAtBar(8)).toBe(16 + 12)
    expect(moveMeterEvent(project, 1, 12).meterMap![1].bar).toBe(7)
    expect(moveMeterEvent(project, 1, 0).meterMap![1].bar).toBe(1)
    expect(moveMeterEvent(project, 0, 3)).toBe(project)
    expect(setMeterEvent(project, 2, 5, 8).meterMap![2]).toEqual({ bar: 8, numerator: 5, denominator: 8 })
    expect(setMeterEvent(project, 2, 7, 8)).toBe(project)
    expect(deleteMeterEvent(project, 1).meterMap).toEqual([{ bar: 0, numerator: 4, denominator: 4 }, { bar: 8, numerator: 7, denominator: 8 }])
    expect(deleteMeterEvent(project, 0)).toBe(project)
    // Bar 0 is the project meter; later changes keep their bar numbers.
    const first = addMeterEvent(project, 0, 6, 8)
    expect(first).toMatchObject({ timeSignature: { numerator: 6, denominator: 8 }, beatsPerBar: 3 })
    expect(first.meterMap!.map(event => event.bar)).toEqual([0, 4, 8])
    expect(setProjectTimeSignature(project, 2, 4).meterMap).toEqual([{ bar: 0, numerator: 2, denominator: 4 }, ...project.meterMap!.slice(1)])
    expect(() => addMeterEvent(project, 3, 0, 4)).toThrow(/numerator/)
  })

  it('commits each gesture as one undo step and never moves music', () => {
    const session = new ProjectSession({ ...createEmptyProject(), tracks: [createTrack('instrument')] })
    const before = session.getSnapshot().history.present
    session.edit(project => addMeterEvent(project, 2, 7, 8), '', '박자 변경 추가')
    session.edit(project => moveMeterEvent(project, 1, 3), '', '박자 변경 이동')
    const after = session.getSnapshot().history.present
    expect(after.meterMap![1]).toEqual({ bar: 3, numerator: 7, denominator: 8 })
    expect(after.tracks).toBe(before.tracks)
    expect(session.getSnapshot().undoLabel).toBe('박자 변경 이동')
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present.meterMap![1].bar).toBe(2)
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present).toEqual(before)
  })
})

describe('schema 18 meter map files', () => {
  it('migrates older projects to one meter event at bar 1', () => {
    for (const schemaVersion of [5, 14, 17]) {
      const { meterMap: _drop, ...legacy } = setProjectTimeSignature(createEmptyProject(), 6, 8)
      const migrated = validateProject({ ...legacy, schemaVersion })
      expect(migrated.schemaVersion).toBe(PROJECT_SCHEMA_VERSION)
      expect(migrated.meterMap).toEqual([{ bar: 0, numerator: 6, denominator: 8 }])
    }
    // An older file cannot carry changes: a stray field is ignored like a pre-14 tempo map.
    expect(validateProject({ ...song(), schemaVersion: 17 }).meterMap).toEqual([{ bar: 0, numerator: 4, denominator: 4 }])
  })

  it('round-trips changes and rejects broken maps', () => {
    const project = song()
    const loaded = validateProject(JSON.parse(JSON.stringify(project)))
    expect(loaded.meterMap).toEqual(EVENTS)
    expect(loaded.schemaVersion).toBe(18)
    const { meterMap: _drop, ...without } = project
    expect(validateProject(without).meterMap).toEqual([{ bar: 0, numerator: 4, denominator: 4 }])
    expect(() => validateProject({ ...project, meterMap: [EVENTS[0], EVENTS[2], EVENTS[1]] })).toThrow(/sorted/)
    expect(() => validateProject({ ...project, meterMap: [EVENTS[0], EVENTS[1], EVENTS[1]] })).toThrow(/sorted/)
    expect(() => validateProject({ ...project, meterMap: [{ bar: 1, numerator: 4, denominator: 4 }] })).toThrow(/bar 1/)
    expect(() => validateProject({ ...project, meterMap: [{ bar: 0, numerator: 3, denominator: 4 }] })).toThrow(/match/)
    expect(() => validateProject({ ...project, meterMap: [EVENTS[0], { bar: 2.5, numerator: 3, denominator: 4 }] })).toThrow(/bar/)
    expect(() => validateProject({ ...project, meterMap: [EVENTS[0], { bar: 2, numerator: 3, denominator: 5 }] })).toThrow(/denominator/)
    expect(() => validateProject({ ...project, meterMap: 'x' })).toThrow()
  })
})

describe('metronome across meter changes', () => {
  it('accents the first pulse of every bar and keeps compound groups (겹박자)', () => {
    const clicks = meterClicksInRange(songMap(), 0, 16.5).map(click => [click.beat, click.level])
    expect(clicks).toEqual([
      [0, 0], [1, 2], [2, 2], [3, 2],
      [4, 0], [5, 2], [6, 2],
      [7, 0], [7.5, 2], [8, 2], [8.5, 2], [9, 2], [9.5, 2], [10, 2],
      [10.5, 0], [11, 2], [11.5, 2], [12, 1], [12.5, 2], [13, 2],
      [13.5, 0], [14, 2], [14.5, 2], [15, 1], [15.5, 2], [16, 2],
    ])
  })

  it('equals the single-meter grid without changes and does not depend on the scheduler segments', () => {
    const constant = MeterMap.constant({ numerator: 6, denominator: 8 })
    expect(meterClicksInRange(constant, 0, 12)).toEqual(clicksInRange(metronomeGrid({ numerator: 6, denominator: 8 }), 0, 12))
    const map = songMap(), whole = meterClicksInRange(map, 0, 20)
    const edges = [0, .3, 4, 6.99, 7, 10.49, 10.5, 13.6, 20]
    const pieces = edges.slice(1).flatMap((end, index) => meterClicksInRange(map, edges[index], end))
    expect(pieces.map(click => [click.beat, click.level])).toEqual(whole.map(click => [click.beat, click.level]))
  })

  it('schedules the clicks through the tempo map', () => {
    const tempo = new TempoMap(120, [{ beat: 0, bpm: 120, curve: 'step' }, { beat: 7, bpm: 60, curve: 'ramp' }, { beat: 16, bpm: 90, curve: 'step' }])
    const scheduled = scheduleSegment(songMap(), 6, 12, 100, tempo)
    expect(scheduled.map(click => click.beat)).toEqual([6, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5])
    for (const click of scheduled) expect(click.time).toBeCloseTo(100 + tempo.secondsBetween(6, click.beat), 12)
    expect(scheduled.find(click => click.beat === 10.5)!.level).toBe(0)
  })

  it('counts in whole bars of the meter where the transport starts', () => {
    const meter = meterMapOf(song()).meterAt(8)
    expect(countInClicks(meter, 1).lengthBeats).toBe(3.5)
    expect(countInClicks(meter, 1).clicks.map(click => click.level)).toEqual([0, 2, 2, 2, 2, 2, 2])
  })
})

describe('ruler and grid across meter changes', () => {
  it('numbers bars through every meter and draws each change\'s bar line', () => {
    const bars = meterRulerMarks(songMap(), 40, 0, 0, 20).filter(mark => mark.kind === 'bar')
    expect(bars.map(mark => [mark.beat, mark.label])).toEqual([[0, '1'], [4, '2'], [7, '3'], [10.5, '4'], [13.5, '5'], [16.5, '6'], [19.5, '7']])
    const beats = meterRulerMarks(songMap(), 120, 0, 7, 10.5).filter(mark => mark.kind !== 'subdivision')
    expect(beats.map(mark => mark.label)).toEqual(['3', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '4'])
    // One meter: identical to the plain ruler.
    const constant = MeterMap.constant({ numerator: 3, denominator: 4 })
    expect(meterRulerMarks(constant, 60, .25, 0, 24)).toEqual(musicalRulerMarks(musicalGrid(60, { snap: .25, beatsPerBar: 3, beatUnit: 1 }), 0, 24))
  })

  it('clips one repeating grid layer to each meter', () => {
    const style = meterGridStyle(songMap(), 20, 0, 400)
    expect(style.backgroundRepeat).toBe('no-repeat')
    expect(style.backgroundPosition!.split(',').filter(position => position === '140px 0').length).toBeGreaterThan(0)
    expect(style.backgroundImage).toContain('transparent 1px 70px') // a 7/8 bar is 3.5 beats · 20px
    expect(meterGridStyle(MeterMap.constant({ numerator: 4, denominator: 4 }), 30, 0, 400).backgroundPosition).toBeUndefined()
  })
})

describe('MIDI meta events FF 58', () => {
  const withNotes = (project: Project): Project => {
    const track = createTrack('instrument')
    const clip: MidiClip = { kind: 'midi', id: 'c', name: 'c', startBeat: 0, lengthBeats: 20, gain: 1, notes: [{ id: 'n', pitch: 60, start: 0, duration: 1, velocity: .8 }] }
    return { ...project, tracks: [{ ...track, clips: [clip] }] }
  }

  it('exports one time signature per change on its bar line', () => {
    expect(meterEventsForExport(songMap(), 960)).toEqual([
      { tick: 0, numerator: 4, denominatorPower: 2, clocksPerClick: 24 }, { tick: 3840, numerator: 3, denominatorPower: 2, clocksPerClick: 24 },
      { tick: 6720, numerator: 7, denominatorPower: 3, clocksPerClick: 12 }, { tick: 10080, numerator: 6, denominatorPower: 3, clocksPerClick: 36 },
    ])
  })

  it('imports the changes back into the meter map of an empty project', async () => {
    const parsed = parseMidiFile(writeMidiFile(withNotes(song())))
    expect(parsed.timeSignature).toEqual({ numerator: 4, denominator: 4 })
    expect(parsed.meterMap).toEqual(EVENTS.slice(1))
    expect(parsed.warnings).toEqual([])
    const plan = await planMediaImport(createEmptyProject(), [{ kind: 'midi', name: 'song.mid', midi: parsed }], {})
    expect(plan.project.meterMap).toEqual(EVENTS)
  })

  it('moves a change that is off a bar line to the next bar and drops repeats', () => {
    const result = meterEventsFromSmf([
      { beat: 0, numerator: 3, denominator: 4 }, { beat: 3, numerator: 3, denominator: 4 }, { beat: 7, numerator: 5, denominator: 8 }, { beat: 9.5, numerator: 2, denominator: 4 },
    ])
    expect(result.initial).toEqual({ numerator: 3, denominator: 4 })
    // Beat 7 is inside bar 3 (6–9) of 3/4: it moves to bar index 3 (beat 9). 5/8 bars are 2.5 beats: beat 9.5 is not a bar line either → bar 4 (11.5).
    expect(result.events).toEqual([{ bar: 3, numerator: 5, denominator: 8 }, { bar: 4, numerator: 2, denominator: 4 }])
    expect(result.moved).toBe(2)
  })
})

describe('native timeline', () => {
  it('carries the meter map with derived bar-line beats only when the meter changes', () => {
    expect(compileNativeTimeline(createEmptyProject()).meterMap).toBeUndefined()
    expect(compileNativeTimeline(song()).meterMap).toEqual(songMap().segments.map(({ bar, beat, numerator, denominator }) => ({ bar, beat, numerator, denominator })))
  })
})
