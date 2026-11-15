import { describe, expect, it } from 'vitest'
import {
  automationShape, automationState, copyAutomation, evaluateLane, parseTargetKey, pruneAutomation, pruneProjectAutomation, removeLane,
  replaceRange, targetDef, targetGroups, targetKey, thinPoints, trackAt, updateLane, valueAt,
} from './automation'
import { AutomationPass } from './automationRecording'
import { createDevice, createEmptyProject, createTrack, duplicateTrack, duplicateTrackSettings, moveDevice, validateProject } from './project'
import { compileNativeTimeline } from '../audio/native/timeline'
import type { AutomationLane, Project, Track } from './types'

const lane = (target: AutomationLane['target'], points: AutomationLane['points'], extra: Partial<AutomationLane> = {}): AutomationLane => ({ id: `lane-${targetKey(target)}`, target, points, ...extra })

function automatedTrack(): Track {
  const filter = createDevice('filter'), delay = createDevice('delay')
  return {
    ...createTrack('instrument', 'keys'), id: 'track', devices: [filter, delay],
    automation: [
      lane({ kind: 'track', param: 'volume' }, [{ beat: 0, value: 0 }, { beat: 4, value: 0.5 }]),
      lane({ kind: 'device', deviceId: filter.id, param: 'cutoff' }, [{ beat: 0, value: 1 }, { beat: 8, value: 0 }]),
      lane({ kind: 'device', deviceId: delay.id, param: 'amount' }, [{ beat: 2, value: 0.25 }]),
    ],
  }
}

describe('automation evaluation', () => {
  it('interpolates, holds outside the points and jumps on equal beats', () => {
    const points = [{ beat: 1, value: 0 }, { beat: 3, value: 1 }, { beat: 3, value: 0.2 }, { beat: 5, value: 0.2 }]
    expect(evaluateLane([], 2)).toBeUndefined()
    expect(evaluateLane(points, 0)).toBe(0)
    expect(evaluateLane(points, 2)).toBeCloseTo(0.5, 12)
    expect(evaluateLane(points, 3)).toBe(0.2)
    expect(evaluateLane(points, 99)).toBe(0.2)
    expect(evaluateLane(points, 2, true)).toBe(0)
  })

  it('bends curved segments the same way as the native engine', () => {
    expect(automationShape(0.5, 0)).toBe(0.5)
    expect(automationShape(0.5, 1)).toBeCloseTo((Math.exp(3) - 1) / (Math.exp(6) - 1), 12)
    expect(automationShape(0.5, -1)).toBeCloseTo((Math.exp(-3) - 1) / (Math.exp(-6) - 1), 12)
    expect(automationShape(0, 0.7)).toBe(0)
    expect(automationShape(1, -0.7)).toBeCloseTo(1, 12)
    const curved = evaluateLane([{ beat: 0, value: 0, curve: 0.5 }, { beat: 1, value: 1 }], 0.5)!
    expect(curved).toBeLessThan(0.5)
  })

  it('maps lanes into each target range (log cutoff, linear volume) and follows them in trackAt', () => {
    const track = automatedTrack()
    const filter = track.devices[0]
    expect(valueAt(track, { kind: 'track', param: 'volume' }, 2)).toBeCloseTo(0.5, 9)
    expect(valueAt(track, { kind: 'device', deviceId: filter.id, param: 'cutoff' }, 4)).toBeCloseTo(Math.sqrt(20 * 20000), 6)
    const at = trackAt(track, 2)
    expect(at.volume).toBeCloseTo(0.5, 9)
    expect(at.devices[1].type !== 'vst3' && at.devices[1].params.amount).toBeCloseTo(0.25, 9)
    const off = { ...track, automation: track.automation!.map(item => ({ ...item, enabled: false })) }
    expect(trackAt(off, 2)).toBe(off)
    expect(automationState(off, { kind: 'track', param: 'volume' })).toBe('override')
    expect(automationState(track, { kind: 'track', param: 'pan' })).toBeNull()
  })

  it('keys targets so new kinds slot in without colliding', () => {
    for (const key of ['track:volume', 'device:abc:cutoff', 'instrument:level', 'plugin:12']) expect(targetKey(parseTargetKey(key)!)).toBe(key)
    expect(parseTargetKey('plugin:abc')).toBeNull()
    expect(parseTargetKey('track:gain')).toBeNull()
  })
})

describe('automation thinning and lane edits', () => {
  it('thins a recorded ramp to its corners within tolerance', () => {
    const samples = Array.from({ length: 101 }, (_, i) => ({ beat: i / 10, value: i < 50 ? i / 50 : 1 }))
    const thinned = thinPoints(samples, 0.001)
    expect(thinned.length).toBeLessThan(6)
    expect(thinned[0]).toEqual({ beat: 0, value: 0 })
    expect(thinned.at(-1)).toEqual({ beat: 10, value: 1 })
    for (const sample of samples) expect(Math.abs(evaluateLane(thinned, sample.beat)! - sample.value)).toBeLessThan(0.0011)
  })

  it('replaces a range and keeps the points outside it', () => {
    const points = [{ beat: 0, value: 0 }, { beat: 2, value: 1 }, { beat: 4, value: 0 }, { beat: 6, value: 1 }]
    expect(replaceRange(points, 1.5, 4.5, [{ beat: 3, value: 0.5 }])).toEqual([{ beat: 0, value: 0 }, { beat: 3, value: 0.5 }, { beat: 6, value: 1 }])
  })

  it('creates, edits and removes lanes', () => {
    const track = createTrack('audio', 'keys')
    const added = updateLane(track, { kind: 'track', param: 'pan' }, current => ({ ...current, points: [{ beat: 1, value: 0.25 }] }))
    expect(added.automation).toHaveLength(1)
    const removed = removeLane(added, added.automation![0].id)
    expect(removed.automation).toBeUndefined()
  })
})

describe('device move, delete and duplicate keep lanes coherent', () => {
  it('moving a device keeps its lanes; deleting it removes them', () => {
    const track = automatedTrack()
    const moved = moveDevice(track, track.devices[0].id, 1)
    expect(moved.automation).toBe(track.automation)
    expect(pruneAutomation(moved)).toBe(moved)
    const deleted = pruneAutomation({ ...track, devices: track.devices.slice(1) })
    expect(deleted.automation!.map(item => item.target.kind)).toEqual(['track', 'device'])
    expect(deleted.automation!.some(item => item.target.kind === 'device' && item.target.deviceId === track.devices[0].id)).toBe(false)
  })

  it('changing the instrument drops parameters the new instrument lacks', () => {
    const track: Track = { ...createTrack('instrument', 'keys'), automation: [lane({ kind: 'instrument', param: 'bell' }, [{ beat: 0, value: 1 }])] }
    expect(pruneAutomation(track).automation).toHaveLength(1)
    expect(pruneAutomation({ ...track, instrument: 'bass', instrumentParams: {} }).automation).toBeUndefined()
  })

  it('duplicating a track copies lanes onto the copied devices', () => {
    const track = automatedTrack()
    for (const copy of [duplicateTrack(track), duplicateTrackSettings(track)]) {
      expect(copy.automation).toHaveLength(3)
      const device = copy.automation!.find(item => item.target.kind === 'device')!
      expect(device.target.kind === 'device' && device.target.deviceId).toBe(copy.devices[0].id)
      expect(copy.automation![0].id).not.toBe(track.automation![0].id)
      expect(copy.automation![0].points).not.toBe(track.automation![0].points)
      expect(copyAutomation(track, copy)).toHaveLength(3)
    }
  })

  it('prunes a whole project', () => {
    const project: Project = { ...createEmptyProject(), tracks: [{ ...automatedTrack(), devices: [] }] }
    expect(pruneProjectAutomation(project).tracks[0].automation).toHaveLength(1)
  })

  it('groups targets by track, device and instrument', () => {
    const groups = targetGroups(automatedTrack())
    expect(groups.map(group => group.label)).toEqual(['트랙', '1. Sweep', expect.stringContaining('2.'), '악기'])
    expect(groups[1].options.map(option => option.label)).toContain('컷오프')
    expect(targetDef(automatedTrack(), { kind: 'device', deviceId: 'missing', param: 'cutoff' })).toBeNull()
  })
})

describe('schema 17 migration', () => {
  const base = () => ({ ...createEmptyProject(), tracks: [automatedTrack()] })

  it('round-trips lanes and mode, sorts points and drops dangling lanes', () => {
    const project = base()
    const track = { ...project.tracks[0], automationMode: 'latch' as const, automation: [...project.tracks[0].automation!, lane({ kind: 'device', deviceId: 'gone', param: 'cutoff' }, [{ beat: 0, value: 1 }])] }
    track.automation[0] = { ...track.automation[0], points: [{ beat: 4, value: 0.5 }, { beat: 0, value: 0, curve: 0.5 }], enabled: false }
    const parsed = validateProject(JSON.parse(JSON.stringify({ ...project, tracks: [track] })))
    expect(parsed.schemaVersion).toBe(17)
    expect(parsed.tracks[0].automationMode).toBe('latch')
    expect(parsed.tracks[0].automation).toHaveLength(3)
    expect(parsed.tracks[0].automation![0]).toMatchObject({ enabled: false, points: [{ beat: 0, value: 0, curve: 0.5 }, { beat: 4, value: 0.5 }] })
  })

  it('accepts schema 1-17 and rejects automation before 17', () => {
    const project = base()
    expect(() => validateProject({ ...project, schemaVersion: 16 })).toThrow(/schema version 17/)
    const { automation: _a, ...plain } = project.tracks[0]
    for (const version of [13, 14, 15, 16, 17]) expect(validateProject({ ...project, schemaVersion: version, tracks: [plain] }).schemaVersion).toBe(17)
    expect(() => validateProject({ ...project, schemaVersion: 18 })).toThrow(/1 through 17/)
  })

  it('rejects malformed lanes', () => {
    const project = base()
    const bad = (automation: unknown) => () => validateProject({ ...project, tracks: [{ ...project.tracks[0], automation }] })
    expect(bad([{ id: 'a', target: { kind: 'track', param: 'gain' }, points: [] }])).toThrow(/automation target/)
    expect(bad([{ id: 'a', target: { kind: 'track', param: 'pan' }, points: [{ beat: 0, value: 2 }] }])).toThrow(/value/)
    expect(bad([{ id: 'a', target: { kind: 'track', param: 'pan' }, points: [] }, { id: 'b', target: { kind: 'track', param: 'pan' }, points: [] }])).toThrow(/duplicates/)
    expect(() => validateProject({ ...project, tracks: [{ ...project.tracks[0], automationMode: 'auto' }] })).toThrow(/automation mode/)
  })
})

describe('automation recording passes', () => {
  const project = (mode: Track['automationMode']): Project => ({ ...createEmptyProject(), tracks: [{ ...createTrack('audio', 'keys'), id: 't', automationMode: mode, volume: 1 }] })
  const volume = { kind: 'track', param: 'volume' } as const

  it('read mode never records', () => {
    const p = project('read')
    const pass = new AutomationPass(p, 0)
    expect(pass.touch(p.tracks[0], volume, 0.5, 1)).toBe(false)
    expect(pass.apply(p)).toBe(p)
  })

  it('touch writes while held and returns to the previous value, as one result', () => {
    const p = project('touch')
    const pass = new AutomationPass(p, 0)
    for (let i = 0; i <= 20; i++) pass.touch(p.tracks[0], volume, 1 - i / 40, 4 + i / 10)
    pass.release('t', volume, 6)
    pass.advance(8)
    pass.stop(8)
    const lanePoints = pass.apply(p).tracks[0].automation![0].points
    expect(lanePoints.length).toBeLessThan(8)
    expect(evaluateLane(lanePoints, 2)).toBeCloseTo(0.5, 6)       // before: static volume 1 of 0..2
    expect(evaluateLane(lanePoints, 5)).toBeCloseTo(0.375, 3)     // written ramp
    expect(evaluateLane(lanePoints, 7)).toBeCloseTo(0.5, 6)       // returned after release
  })

  it('latch keeps the last value until stop', () => {
    const p = project('latch')
    const pass = new AutomationPass(p, 0)
    pass.touch(p.tracks[0], volume, 0.4, 2)
    pass.release('t', volume, 2.5)
    pass.advance(6)
    pass.stop(6)
    const points = pass.apply(p).tracks[0].automation![0].points
    expect(evaluateLane(points, 5)).toBeCloseTo(0.2, 6)
    expect(evaluateLane(points, 6.5)).toBeCloseTo(0.5, 6)
  })

  it('write overwrites existing lanes from the start of the pass and splits at cycle jumps', () => {
    const p = project('write')
    p.tracks[0] = { ...p.tracks[0], automation: [lane(volume, [{ beat: 0, value: 0 }, { beat: 16, value: 1 }])] }
    const pass = new AutomationPass(p, 4)
    pass.advance(8)
    pass.advance(2)  // cycle back
    pass.advance(3)
    pass.stop(3)
    const points = pass.apply(p).tracks[0].automation![0].points
    expect(evaluateLane(points, 6)).toBeCloseTo(0.25, 6)    // held value from beat 4
    expect(evaluateLane(points, 2.5)).toBeCloseTo(0.25, 6)  // after the cycle jump the held value continues
    expect(evaluateLane(points, 12)).toBeCloseTo(0.75, 6)   // untouched outside the ranges
  })

  it('lets the engine hear the written value instead of the lane while touching', () => {
    const p = project('touch')
    p.tracks[0] = { ...p.tracks[0], automation: [lane(volume, [{ beat: 0, value: 0 }])] }
    const pass = new AutomationPass(p, 0)
    pass.touch(p.tracks[0], volume, 1.5, 1)
    const heard = pass.engineProject(p).tracks[0]
    expect(heard.volume).toBeCloseTo(1.5, 9)
    expect(heard.automation ?? []).toHaveLength(0)
    pass.release('t', volume, 2)
    expect(pass.engineProject(p)).toBe(p)
  })
})

describe('native timeline automation', () => {
  it('compiles active lanes into frames with their mapping', () => {
    const track = automatedTrack()
    const project: Project = { ...createEmptyProject(), bpm: 120, sampleRate: 48000, tracks: [{ ...track, automation: [...track.automation!, lane({ kind: 'track', param: 'mute' }, [{ beat: 1, value: 1 }]), lane({ kind: 'track', param: 'pan' }, [{ beat: 1, value: 1 }], { enabled: false })] }] }
    const compiled = compileNativeTimeline(project, new Map(), 1).tracks[0]
    expect(compiled.automation!.map(item => item.target.kind)).toEqual(['volume', 'insert', 'insert', 'mute'])
    expect(compiled.automation![0]).toMatchObject({ minimum: 0, maximum: 2, points: [{ frame: 0, value: 0 }, { frame: 96000, value: 0.5 }] })
    expect(compiled.automation![1]).toMatchObject({ target: { kind: 'insert', insertId: track.devices[0].id, param: 'cutoff' }, logarithmic: true, minimum: 20, maximum: 20000 })
    expect(compiled.automation![3].options).toEqual([0, 1])
    expect(compiled.unmutedAudible).toBe(true)
  })
})
