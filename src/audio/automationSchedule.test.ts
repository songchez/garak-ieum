import { describe, expect, it, vi } from 'vitest'
import { AUTOMATION_STEP_FRAMES, scheduleAutomation, type EngineGraph } from './graph'
import { createDevice, createEmptyProject, createTrack } from '../core/project'
import type { Project, Track } from '../core/types'

function param() { return { setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn() } }
function fakeGraph(track: Track, sampleRate = 48000) {
  const fader = { gain: param() }, panner = { pan: param() }
  const devices = new Map(track.devices.map(device => [device.id, { input: {}, output: {}, update: vi.fn(), ...(device.type === 'delay' ? { schedule: vi.fn() } : {}) }]))
  const graph = { context: { sampleRate, currentTime: 0 }, tracks: new Map([[track.id, { fader, panner, devices }]]) } as unknown as EngineGraph
  return { graph, fader, panner, devices }
}

describe('web automation scheduling', () => {
  const step = AUTOMATION_STEP_FRAMES / 48000
  const filter = createDevice('filter'), delay = createDevice('delay')
  const track: Track = {
    ...createTrack('audio', 'keys'), id: 't', devices: [filter, delay],
    automation: [
      { id: 'v', target: { kind: 'track', param: 'volume' }, points: [{ beat: 0, value: 0 }, { beat: 1, value: 1 }] },
      { id: 'c', target: { kind: 'device', deviceId: filter.id, param: 'cutoff' }, points: [{ beat: 0, value: 0 }, { beat: 1, value: 1 }] },
      { id: 'd', target: { kind: 'device', deviceId: delay.id, param: 'amount' }, points: [{ beat: 0, value: 0.5 }] },
    ],
  }
  const project: Project = { ...createEmptyProject(), bpm: 120, tracks: [track] }
  const beatAt = (time: number) => time * 2

  it('schedules one value per render quantum on an absolute grid', () => {
    const { graph, fader } = fakeGraph(track)
    scheduleAutomation(graph, project, 0.1, 0.2, beatAt)
    const calls = fader.gain.setTargetAtTime.mock.calls
    expect(calls.length).toBe(Math.ceil(0.2 / step - 1e-9) - Math.ceil(0.1 / step - 1e-9))
    for (const [value, time] of calls) {
      expect(Math.abs(time / step - Math.round(time / step))).toBeLessThan(1e-6)
      expect(value).toBeCloseTo(Math.min(1, beatAt(time)) * 2, 6)
    }
    // A following window continues without overlap.
    const { graph: next, fader: nextFader } = fakeGraph(track)
    scheduleAutomation(next, project, 0.2, 0.3, beatAt)
    expect(nextFader.gain.setTargetAtTime.mock.calls[0][1]).toBeGreaterThan(calls.at(-1)![1])
  })

  it('updates AudioParam devices at the step times and batches worklet devices', () => {
    const { graph, devices } = fakeGraph(track)
    scheduleAutomation(graph, project, 0, 0.05, beatAt)
    const cutoff = devices.get(filter.id)!.update.mock.calls
    expect(cutoff.length).toBeGreaterThan(10)
    const [params, bpm, at, smooth] = cutoff[5]
    expect(bpm).toBe(120); expect(smooth).toBe(true)
    expect(params.cutoff).toBeCloseTo(20 * Math.pow(1000, beatAt(at)), 3)
    // A flat lane sends one event, as a single batched schedule() call.
    const scheduled = (devices.get(delay.id) as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule.mock.calls
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0][0]).toHaveLength(1)
    expect(scheduled[0][0][0].params.amount).toBeCloseTo(0.5, 9)
  })

  it('ignores disabled lanes and tracks without automation', () => {
    const off: Track = { ...track, automation: track.automation!.map(lane => ({ ...lane, enabled: false })) }
    const { graph, fader, devices } = fakeGraph(off)
    scheduleAutomation(graph, { ...project, tracks: [off] }, 0, 0.1, beatAt)
    expect(fader.gain.setTargetAtTime).not.toHaveBeenCalled()
    expect(devices.get(filter.id)!.update).not.toHaveBeenCalled()
  })
})
