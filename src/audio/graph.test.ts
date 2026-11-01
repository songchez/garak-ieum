import { describe, expect, it, vi } from 'vitest'
import { createEmptyProject, createTrack } from '../core/project'
import type { MidiClip, Project } from '../core/types'
import { connectMonitor, createGraph, disconnectMonitor, disposeGraph, scheduleRange, updateGraph } from './graph'
import type { LoadedSet, SampleLibrary } from './samples'

// These are Web Audio scheduling/connection spies, not a DSP or listening test.
class Parameter {
  value = 0
  cancelScheduledValues = vi.fn()
  setValueAtTime = vi.fn((value: number, _time: number) => { this.value = value })
  setTargetAtTime = vi.fn((value: number, _time: number, _constant: number) => { this.value = value })
  linearRampToValueAtTime = vi.fn((value: number, _time: number) => { this.value = value })
  exponentialRampToValueAtTime = vi.fn((value: number, _time: number) => { this.value = value })
}

class AudioNodeSpy {
  connections = new Set<unknown>()
  connect = vi.fn((target: unknown) => { this.connections.add(target); return target as AudioNodeSpy })
  disconnect = vi.fn((target?: unknown) => { if (target) this.connections.delete(target); else this.connections.clear() })
  gain = new Parameter()
  pan = new Parameter()
  frequency = new Parameter()
  Q = new Parameter()
  threshold = new Parameter()
  knee = new Parameter()
  ratio = new Parameter()
  attack = new Parameter()
  release = new Parameter()
  playbackRate = new Parameter()
  buffer: AudioBuffer | null = null
  fftSize = 256
  type = ''
  loop = false
  loopStart = 0
  loopEnd = 0
  onended: (() => void) | null = null
  start = vi.fn<(...args: number[]) => void>()
  stop = vi.fn<(...args: number[]) => void>()
}

function contextSpy() {
  const sources: AudioNodeSpy[] = []
  const context = {
    currentTime: 0, sampleRate: 48000, destination: new AudioNodeSpy(),
    createGain: () => new AudioNodeSpy(),
    createStereoPanner: () => new AudioNodeSpy(),
    createAnalyser: () => new AudioNodeSpy(),
    createDynamicsCompressor: () => new AudioNodeSpy(),
    createBiquadFilter: () => new AudioNodeSpy(),
    createBufferSource: () => { const source = new AudioNodeSpy(); sources.push(source); return source },
  } as unknown as BaseAudioContext
  return { context, sources }
}

const sample: LoadedSet = {
  set: {
    id: 'salamander', kind: 'pitched', formats: ['webm'], gainDb: 0, release: 0.1,
    zones: [{ file: 'tone', root: 60, lo: 0, hi: 127, vlo: 0, vhi: 1 }], releaseZones: [],
    attribution: { title: 'Test tone', author: 'Test', license: 'CC0' },
  },
  buffers: new Map([['tone', { duration: 1 } as AudioBuffer]]), format: 'webm', startOffset: 0,
}
const library = { get: () => sample } as unknown as SampleLibrary
const clip = (patch: Partial<MidiClip> = {}): MidiClip => ({
  id: 'clip', name: 'Notes', kind: 'midi', startBeat: 0, lengthBeats: 1, gain: 1,
  notes: [{ id: 'note', pitch: 60, start: 0.3, duration: 0.2, velocity: 0.8 }], ...patch,
})
function projectFor(region: MidiClip): Project {
  return { ...createEmptyProject(), bpm: 120, lengthBeats: 4, tracks: [{ ...createTrack('instrument', 'grand'), id: 'track', clips: [region] }] }
}

describe('playback transforms reach the Web Audio scheduler', () => {
  it.each([
    { quantize: 0, swing: 66, seconds: 0.15 },
    { quantize: 0.5, swing: 50, seconds: 0.25 },
    { quantize: 0.5, swing: 66, seconds: 0.33 },
  ])('schedules the source with quantize=$quantize and swing=$swing', ({ quantize, swing, seconds }) => {
    const { context, sources } = contextSpy()
    const project = projectFor(clip({ quantize, swing }))
    const graph = createGraph(context, project)
    scheduleRange(graph, project, new Map(), 0, 4, 10, 4, true, false, library)
    expect(sources).toHaveLength(1)
    expect(sources[0].start.mock.calls[0][0]).toBeCloseTo(10 + seconds)
    disposeGraph(graph)
  })

  it.each([false, true])('repeats only to the next region, once per onset across adjacent ranges (realtime=%s)', realtime => {
    const { context, sources } = contextSpy()
    const project = projectFor(clip({ loop: true, transpose: 5, quantize: 0.5, swing: 66 }))
    project.tracks[0] = {
      ...project.tracks[0], transpose: 7,
      clips: [...project.tracks[0].clips, clip({ id: 'next', startBeat: 2.5, mute: true })],
    }
    const graph = createGraph(context, project)
    for (let beat = 0; beat < 4; beat += 0.25) {
      scheduleRange(graph, project, new Map(), beat, beat + 0.25, 10 + beat / 2, 4, beat === 0, realtime, library)
    }
    // The third occurrence ends at beat 2.5, before its swung note at beat 2.66.
    expect(sources.map(source => source.start.mock.calls[0][0])).toEqual([10.33, 10.83])
    expect(sources.map(source => source.playbackRate.value)).toEqual([2, 2])
    expect(project.tracks[0].clips[0]).toMatchObject({ notes: [{ pitch: 60, start: 0.3 }] })
    disposeGraph(graph)
  })

  it('does not schedule disabled tracks or muted regions', () => {
    const { context, sources } = contextSpy()
    const project = projectFor(clip({ mute: true }))
    project.tracks.push({ ...createTrack('instrument', 'grand'), enabled: false, clips: [clip()] })
    const graph = createGraph(context, project)
    scheduleRange(graph, project, new Map(), 0, 4, 0, 4, true, false, library)
    expect(sources).toHaveLength(0)
    disposeGraph(graph)
  })
})

describe('input monitoring uses the live channel graph', () => {
  const audioProject = (): Project => ({
    ...createEmptyProject(), tracks: [
      { ...createTrack('audio'), id: 'a', monitor: true },
      { ...createTrack('audio'), id: 'b', monitor: true },
    ],
  })

  it('rewires selected inputs without duplicate routes, and follows the track fader', () => {
    const { context } = contextSpy()
    const project = audioProject()
    const graph = createGraph(context, project)
    const source = new AudioNodeSpy()
    const input = source as unknown as MediaStreamAudioSourceNode
    connectMonitor(graph, input, ['a', 'missing'])
    expect([...source.connections]).toEqual([graph.tracks.get('a')!.input])
    connectMonitor(graph, input, ['b'])
    expect([...source.connections]).toEqual([graph.tracks.get('b')!.input])
    updateGraph(graph, { ...project, tracks: project.tracks.map(track => ({ ...track, mute: true })) })
    expect(graph.tracks.get('b')!.fader.gain.value).toBe(0)
    updateGraph(graph, { ...project, tracks: project.tracks.map(track => ({ ...track, volume: 0.4 })) })
    expect(graph.tracks.get('b')!.fader.gain.value).toBe(0.4)
    disconnectMonitor(graph)
    expect(source.connections.size).toBe(0)
    disposeGraph(graph)
  })

  it('keeps the replacement graph connected when the retired graph is disposed', () => {
    const { context } = contextSpy()
    const project = audioProject()
    const previous = createGraph(context, project)
    const replacement = createGraph(context, project)
    const source = new AudioNodeSpy()
    const input = source as unknown as MediaStreamAudioSourceNode
    connectMonitor(previous, input, ['a'])
    connectMonitor(replacement, input, ['a'])
    disposeGraph(previous)
    expect([...source.connections]).toEqual([replacement.tracks.get('a')!.input])
    disposeGraph(replacement)
    expect(source.connections.size).toBe(0)
  })
})
