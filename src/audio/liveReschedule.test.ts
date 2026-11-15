import { describe, expect, it, vi } from 'vitest'
import { createEmptyProject, createTrack } from '../core/project'
import type { MidiClip, Project } from '../core/types'
import { createGraph, disposeGraph, scheduleRange, stopTrackVoices } from './graph'
import type { LoadedSet, SampleLibrary } from './samples'

// Web Audio scheduling spies (no DSP): which voices an edit during playback replaces.
class Parameter {
  value = 0
  cancelScheduledValues = vi.fn()
  setValueAtTime = vi.fn()
  setTargetAtTime = vi.fn()
  linearRampToValueAtTime = vi.fn()
  exponentialRampToValueAtTime = vi.fn()
}
class NodeSpy {
  connect = vi.fn((target: unknown) => target)
  disconnect = vi.fn()
  gain = new Parameter(); pan = new Parameter(); frequency = new Parameter(); Q = new Parameter(); playbackRate = new Parameter(); detune = new Parameter()
  threshold = new Parameter(); knee = new Parameter(); ratio = new Parameter(); attack = new Parameter(); release = new Parameter()
  buffer: AudioBuffer | null = null
  fftSize = 256; type = ''; loop = false; loopStart = 0; loopEnd = 0
  onended: (() => void) | null = null
  start = vi.fn<(...args: number[]) => void>()
  stop = vi.fn<(...args: number[]) => void>()
}
function contextSpy() {
  const sources: NodeSpy[] = []
  const node = () => new NodeSpy()
  const context = {
    currentTime: 0, sampleRate: 48000, destination: new NodeSpy(),
    createGain: node, createStereoPanner: node, createAnalyser: node, createDynamicsCompressor: node, createBiquadFilter: node,
    createConstantSource: () => Object.assign(new NodeSpy(), { offset: new Parameter() }), createOscillator: node,
    createBufferSource: () => { const source = node(); sources.push(source); return source },
  } as unknown as BaseAudioContext & { currentTime: number }
  return { context, sources }
}
const sample: LoadedSet = {
  set: { id: 'salamander', kind: 'pitched', formats: ['webm'], gainDb: 0, release: 0.1, zones: [{ file: 'tone', root: 60, lo: 0, hi: 127, vlo: 0, vhi: 1 }], releaseZones: [], attribution: { title: 't', author: 't', license: 'CC0' } },
  buffers: new Map([['tone', { duration: 4 } as AudioBuffer]]), format: 'webm', startOffset: 0,
}
const library = { get: () => sample } as unknown as SampleLibrary
const region = (starts: number[], duration = 0.2): MidiClip => ({
  id: 'clip-' + starts.join('-'), name: 'n', kind: 'midi', startBeat: 0, lengthBeats: 4, gain: 1,
  notes: starts.map((start, index) => ({ id: `n${index}`, pitch: 60, start, duration, velocity: 0.8 })),
})
function project(a: MidiClip, b: MidiClip): Project {
  return { ...createEmptyProject(), bpm: 120, lengthBeats: 4, tracks: [{ ...createTrack('instrument', 'grand'), id: 'A', clips: [a] }, { ...createTrack('instrument', 'grand'), id: 'B', clips: [b] }] }
}
const starts = (sources: NodeSpy[]) => sources.map(source => source.start.mock.calls[0][0])

describe('live edit rescheduling (web engine)', () => {
  it('replaces only the edited track’s unheard onsets and leaves the other track’s voices alone', () => {
    const { context, sources } = contextSpy()
    const before = project(region([0.3, 2.3]), region([0.5, 2.5]))
    const graph = createGraph(context, before)
    scheduleRange(graph, before, new Map(), 0, 4, 0, 4, true, true, library)
    expect(starts(sources)).toEqual([0.15, 1.15, 0.25, 1.25])
    // Half a second in: A's first note has sounded, its second has not.
    context.currentTime = 0.5
    expect(stopTrackVoices(graph, 'A', 0.5, false)).toBe(1)
    const after = { ...before, tracks: [{ ...before.tracks[0], clips: [region([0.3, 3])] }, before.tracks[1]] }
    scheduleRange(graph, after, new Map(), 1, 4, 0.5, 4, true, true, library, new Map([['A', false]]))
    // One new onset for A at beat 3 (1.5 s); B was not rescheduled and the sounding A note was not chased.
    expect(starts(sources.slice(4))).toEqual([1.5])
    expect(stopTrackVoices(graph, 'B', 0, true)).toBe(2)
    disposeGraph(graph)
  })

  it('a hard change cuts sounding notes and chases the sustained ones for that track only', () => {
    const { context, sources } = contextSpy()
    const before = project(region([0], 2), region([0], 2))
    const graph = createGraph(context, before)
    scheduleRange(graph, before, new Map(), 0, 4, 0, 4, true, true, library)
    expect(sources).toHaveLength(2)
    context.currentTime = 0.5
    expect(stopTrackVoices(graph, 'A', 0.5, true)).toBe(1)
    const after = { ...before, tracks: [{ ...before.tracks[0], transpose: 2 }, before.tracks[1]] }
    scheduleRange(graph, after, new Map(), 1, 4, 0.5, 4, true, true, library, new Map([['A', true]]))
    // The held A note is chased from beat 1; B keeps its single voice.
    expect(starts(sources.slice(2))).toEqual([0.5])
    expect(stopTrackVoices(graph, 'B', 0, true)).toBe(1)
    disposeGraph(graph)
  })
})
