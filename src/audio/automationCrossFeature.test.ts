import { describe, expect, it, vi } from 'vitest'
import { AUTOMATION_STEP_FRAMES, scheduleAutomation, updateEffectTempo, type EngineGraph } from './graph'
import { automationFrames, compileNativeTimeline, type NativeAutomationLane } from './native/timeline'
import { positionAfter } from './math'
import { automationShape, targetGroups, targetKey, parseTargetKey, valueAt } from '../core/automation'
import { createDevice, createEmptyProject, createTrack, validateProject } from '../core/project'
import { applySend, createReturnTrack } from '../core/sends'
import { tempoMapOf } from '../core/tempoMap'
import type { AutomationPoint, Project, TempoPoint, Track } from '../core/types'

/**
 * Cross-feature behaviour (docs/AUTOMATION.md): automation × tempo map × sends/returns, in both engines.
 * The Web Audio side is checked through scheduleAutomation with the beat mapping the engine uses; the native
 * side through the compiled timeline, evaluated the way native/src/engine.cpp evaluateAutomation() does.
 */

const RATE = 48000
const param = () => ({ setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn() })
function fakeGraph(tracks: readonly Track[]) {
  const channels = new Map(tracks.map(track => [track.id, {
    fader: { gain: param() }, panner: { pan: param() },
    devices: new Map(track.devices.map(device => [device.id, { input: {}, output: {}, update: vi.fn(), ...(device.type === 'delay' ? { schedule: vi.fn() } : {}) }])),
    sends: new Map((track.sends ?? []).map(send => [send.returnId, { gain: { gain: param() }, pre: !!send.pre }])),
  }]))
  return { graph: { context: { sampleRate: RATE, currentTime: 0 }, tracks: channels } as unknown as EngineGraph, channels }
}
/** native/src/engine.cpp evaluateAutomation + automationValue for a linear lane. */
function nativeValue(lane: NativeAutomationLane, frame: number): number {
  const p = lane.points
  let i = -1
  while (i + 1 < p.length && p[i + 1].frame <= frame) i++
  let n: number
  if (i < 0) n = p[0].value
  else if (i === p.length - 1 || lane.options) n = p[i].value
  else {
    const a = p[i], b = p[i + 1], span = b.frame - a.frame
    n = span > 1e-9 ? a.value + (b.value - a.value) * automationShape((frame - a.frame) / span, a.curve ?? 0) : b.value
  }
  return lane.minimum + n * (lane.maximum - lane.minimum)
}
const scheduled = (spy: ReturnType<typeof param>) => spy.setTargetAtTime.mock.calls.map(([value, time]) => ({ value: value as number, time: time as number }))

const STEP_MAP: TempoPoint[] = [{ beat: 0, bpm: 240, curve: 'step' }, { beat: 2, bpm: 120, curve: 'step' }]
const RAMP_MAP: TempoPoint[] = [{ beat: 0, bpm: 90, curve: 'ramp' }, { beat: 8, bpm: 180, curve: 'step' }]
const volumeLane = (points: AutomationPoint[]) => ({ id: 'vol', target: { kind: 'track' as const, param: 'volume' as const }, points })
function project(tempoMap: TempoPoint[], tracks: Track[]): Project {
  return { ...createEmptyProject(), bpm: tempoMap[0].bpm, tempoMap, lengthBeats: 16, loop: { enabled: false, startBeat: 0, endBeat: 8 }, tracks }
}

describe('automation under a tempo map', () => {
  for (const [name, map] of [['step', STEP_MAP], ['ramp', RAMP_MAP]] as const) {
    it(`places lanes on the same frames in both engines (${name} tempo map)`, () => {
      const track: Track = { ...createTrack('audio'), id: 'a', automation: [volumeLane([{ beat: 1, value: 0 }, { beat: 3, value: 0.5, curve: 0.4 }, { beat: 6, value: 0.1 }, { beat: 6, value: 0.4 }])] }
      const p = project([...map], [track])
      const tempo = tempoMapOf(p)
      // Web Audio: the realtime scheduler maps context time through the tempo map (positionAfter from the anchor).
      const { graph, channels } = fakeGraph(p.tracks)
      const end = tempo.secondsAt(8)
      scheduleAutomation(graph, p, 0, end, time => positionAfter(p, 0, time))
      const web = scheduled(channels.get('a')!.fader.gain)
      expect(web.length).toBe(Math.ceil(end * RATE / AUTOMATION_STEP_FRAMES - 1e-9))
      // Native: compiled frames through the same map.
      const lane = compileNativeTimeline(p).tracks[0].automation![0]
      for (const point of track.automation![0].points) expect(lane.points.some(item => Math.abs(item.frame - tempo.frameAt(point.beat, RATE)) < 1e-6 && item.value === point.value)).toBe(true)
      let worst = 0
      for (const { value, time } of web) {
        // Both engines agree with the lane evaluated at the beat heard at that time.
        const expected = valueAt(track, { kind: 'track', param: 'volume' }, tempo.beatAt(time))!
        expect(value).toBeCloseTo(expected, 9)
        if (Math.abs(tempo.beatAt(time) - 6) > 1e-3) worst = Math.max(worst, Math.abs(nativeValue(lane, time * RATE) - expected))
      }
      // Step maps split exactly at the tempo point; ramps leave the frame-vs-beat bend of one 1/16-beat piece.
      expect(worst).toBeLessThan(name === 'step' ? 1e-9 : 2e-4)
    })
  }

  it('without the split a ramp would bend the native lane (the split is what makes the engines agree)', () => {
    const tempo = tempoMapOf({ bpm: 90, tempoMap: RAMP_MAP })
    const points = [{ beat: 0, value: 0 }, { beat: 8, value: 1 }]
    const split = automationFrames(points, false, tempo, RATE)
    expect(split.length).toBeGreaterThan(100)
    const mid = tempo.frameAt(4, RATE)
    const lane = (pts: typeof split): NativeAutomationLane => ({ target: { kind: 'volume' }, minimum: 0, maximum: 1, points: pts })
    expect(nativeValue(lane(split), mid)).toBeCloseTo(0.5, 4)
    const unsplit = points.map(point => ({ frame: tempo.frameAt(point.beat, RATE), value: point.value }))
    expect(Math.abs(nativeValue(lane(unsplit), mid) - 0.5)).toBeGreaterThan(0.02)
    // Discrete lanes and constant tempo keep their points as they are.
    expect(automationFrames(points, true, tempo, RATE)).toHaveLength(2)
  })

  it('carries the tempo at each beat with worklet events and keeps automation when the tempo follows', () => {
    const delay = { ...createDevice('delay'), id: 'dly' }, eq = { ...createDevice('eq'), id: 'eq' }
    const track: Track = { ...createTrack('audio'), id: 'a', devices: [delay, eq], automation: [{ id: 'amt', target: { kind: 'device', deviceId: 'dly', param: 'amount' }, points: [{ beat: 0, value: 0.2 }, { beat: 8, value: 0.8 }] }] }
    const p = project([...RAMP_MAP], [track])
    const tempo = tempoMapOf(p)
    const { graph, channels } = fakeGraph(p.tracks)
    scheduleAutomation(graph, p, 0, tempo.secondsAt(8), time => tempo.beatAt(time))
    const node = channels.get('a')!.devices.get('dly') as unknown as { schedule: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
    const events = node.schedule.mock.calls[0][0] as { at: number; bpm: number }[]
    for (const event of events) expect(event.bpm).toBeCloseTo(tempo.bpmAt(tempo.beatAt(event.at)), 9)
    expect(events.at(-1)!.bpm).toBeGreaterThan(170)
    // Tempo follow retunes only the non-automated effect: the automated delay and the fader stay as scheduled.
    updateEffectTempo(graph, p, 150)
    expect(channels.get('a')!.devices.get('eq')!.update).toHaveBeenLastCalledWith(eq.params, 150, 0, true)
    expect(node.update).not.toHaveBeenCalled()
    expect(channels.get('a')!.fader.gain.cancelScheduledValues).not.toHaveBeenCalled()
  })
})

describe('send-level automation', () => {
  const ret: Track = { ...createReturnTrack('리턴 A'), id: 'ret' }
  const sender = (pre = false): Track => ({ ...createTrack('audio'), id: 'a', sends: [{ returnId: 'ret', level: 0.3, ...(pre ? { pre: true } : {}) }],
    automation: [{ id: 's', target: { kind: 'send', returnId: 'ret' }, points: [{ beat: 0, value: 0 }, { beat: 4, value: 0.5 }] }] })

  it('addresses the send by return id and round-trips through the project file', () => {
    expect(targetKey({ kind: 'send', returnId: 'ret' })).toBe('send:ret')
    expect(parseTargetKey('send:ret')).toEqual({ kind: 'send', returnId: 'ret' })
    const groups = targetGroups(sender(), undefined, new Map([['ret', '리턴 A']]))
    expect(groups.find(group => group.label === '센드')!.options.map(option => option.label)).toEqual(['센드 → 리턴 A'])
    const p = project([...STEP_MAP], [sender(), ret])
    const loaded = validateProject(JSON.parse(JSON.stringify(p)))
    expect(loaded.tracks[0].automation).toEqual(p.tracks[0].automation)
    expect(valueAt(loaded.tracks[0], { kind: 'send', returnId: 'ret' }, 2)).toBeCloseTo(0.5, 9)
    expect(() => validateProject({ ...JSON.parse(JSON.stringify(p)), schemaVersion: 16 })).toThrow(/schema version 17/)
  })

  it('drops the lane with its send or its return track', () => {
    const p = project([...STEP_MAP], [sender(), ret])
    expect(validateProject(JSON.parse(JSON.stringify({ ...p, tracks: [sender()] }))).tracks[0].automation).toBeUndefined()
    const removed = applySend(p, 'a', 'ret', null)
    expect(validateProject(JSON.parse(JSON.stringify(removed))).tracks[0].automation).toBeUndefined()
  })

  it('schedules the send gain in Web Audio and compiles a native send lane on the same frames', () => {
    for (const pre of [false, true]) {
      const p = project([...STEP_MAP], [sender(pre), ret])
      const tempo = tempoMapOf(p)
      const { graph, channels } = fakeGraph(p.tracks)
      scheduleAutomation(graph, p, 0, tempo.secondsAt(4), time => tempo.beatAt(time))
      const web = scheduled(channels.get('a')!.sends.get('ret')!.gain.gain)
      expect(web.length).toBeGreaterThan(100)
      const lane = compileNativeTimeline(p).tracks[0].automation![0]
      expect(lane.target).toEqual({ kind: 'send', returnId: 'ret' })
      expect([lane.minimum, lane.maximum]).toEqual([0, 2])
      for (const { value, time } of web) {
        expect(value).toBeCloseTo(tempo.beatAt(time) / 4, 9)
        expect(nativeValue(lane, time * RATE)).toBeCloseTo(value, 9)
      }
    }
    // A muted sender silences its pre-fader send lane, like the static pre-fader send.
    const muted = project([...STEP_MAP], [{ ...sender(true), mute: true }, ret])
    const { graph, channels } = fakeGraph(muted.tracks)
    scheduleAutomation(graph, muted, 0, 1, time => tempoMapOf(muted).beatAt(time))
    expect(scheduled(channels.get('a')!.sends.get('ret')!.gain.gain).every(item => item.value === 0)).toBe(true)
  })
})

describe('return-track automation', () => {
  it('automates a return track volume and its 시김새 in both engines', () => {
    const delay = { ...createDevice('delay'), id: 'rdly' }
    const ret: Track = { ...createReturnTrack('리턴 A'), id: 'ret', devices: [delay], automation: [
      volumeLane([{ beat: 0, value: 0.5 }, { beat: 4, value: 0.25 }]),
      { id: 'fb', target: { kind: 'device', deviceId: 'rdly', param: 'feedback' }, points: [{ beat: 0, value: 0.1 }, { beat: 4, value: 0.9 }] },
    ] }
    const sender: Track = { ...createTrack('audio'), id: 'a', sends: [{ returnId: 'ret', level: 1 }] }
    const p = project([...RAMP_MAP], [sender, ret])
    const groups = targetGroups(ret)
    expect(groups[0].label).toBe('트랙')
    expect(groups).toHaveLength(2) // 트랙 and its delay: a return has no sends and no instrument
    expect(validateProject(JSON.parse(JSON.stringify(p))).tracks[1].automation).toHaveLength(2)
    const tempo = tempoMapOf(p)
    const { graph, channels } = fakeGraph(p.tracks)
    scheduleAutomation(graph, p, 0, tempo.secondsAt(4), time => tempo.beatAt(time))
    const web = scheduled(channels.get('ret')!.fader.gain)
    expect(web.length).toBeGreaterThan(100)
    const compiled = compileNativeTimeline(p).tracks.find(track => track.id === 'ret')!
    expect(compiled.return).toBe(true)
    const lane = compiled.automation!.find(item => item.target.kind === 'volume')!
    for (const { value, time } of web) {
      expect(value).toBeCloseTo(1 - 0.5 * tempo.beatAt(time) / 4, 9)
      expect(Math.abs(nativeValue(lane, time * RATE) - value)).toBeLessThan(2e-4)
    }
    expect(compiled.automation!.some(item => item.target.kind === 'insert' && item.target.insertId === 'rdly')).toBe(true)
    expect((channels.get('ret')!.devices.get('rdly') as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule).toHaveBeenCalled()
  })
})
