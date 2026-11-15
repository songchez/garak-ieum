import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDevice, createEmptyProject, createTrack } from '../core/project'
import type { MidiClip, Project } from '../core/types'
import { connectMonitor, createGraph, disconnectMonitor, disposeGraph, renderTailSeconds, scheduleRange, setRouteMonitoring, trackLayoutKey, updateGraph } from './graph'
import type { LoadedSet, SampleLibrary } from './samples'
import { tempoMapOf } from '../core/tempoMap'
import { EFFECT_MODULES } from '../devices/effects/registry'
import * as guitarRig from '../devices/guitar-rig'

afterEach(() => { vi.restoreAllMocks() })

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
  const nodes: AudioNodeSpy[] = []
  const node = () => { const value = new AudioNodeSpy(); nodes.push(value); return value }
  const context = {
    currentTime: 0, sampleRate: 48000, destination: new AudioNodeSpy(),
    createGain: node,
    createStereoPanner: node,
    createAnalyser: node,
    createDynamicsCompressor: vi.fn(node),
    createBiquadFilter: node,
    createBufferSource: () => { const source = node(); sources.push(source); return source },
  } as unknown as BaseAudioContext
  return { context, sources, nodes }
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

  it('splits the chosen device channels per track and silences channels the stream lacks', () => {
    const { context } = contextSpy()
    const splitters: (AudioNodeSpy & { outputs: number; channelInterpretation?: string })[] = [], mergers: AudioNodeSpy[] = []
    Object.assign(context, {
      createChannelSplitter: (outputs: number) => { const value = Object.assign(new AudioNodeSpy(), { outputs }); splitters.push(value); return value },
      createChannelMerger: () => { const value = new AudioNodeSpy(); mergers.push(value); return value },
    })
    const project: Project = { ...createEmptyProject(), tracks: ['whole', 'mono', 'stereo', 'far'].map(id => ({ ...createTrack('audio'), id })) }
    const graph = createGraph(context, project)
    const source = new AudioNodeSpy()
    const input = (id: string) => graph.tracks.get(id)!.input
    connectMonitor(graph, source as unknown as MediaStreamAudioSourceNode, ['whole', 'mono', 'stereo', 'far'], new Map([['mono', [3]], ['stereo', [0, 1]], ['far', [40]]]))
    const [splitter] = splitters
    expect(splitter).toMatchObject({ outputs: 32, channelInterpretation: 'discrete' })
    expect([...source.connections]).toEqual([splitter, input('whole')])
    expect(splitter.connect.mock.calls).toEqual([[input('mono'), 3, 0], [mergers[0], 0, 0], [mergers[0], 1, 1]])
    expect([...mergers[0].connections]).toEqual([input('stereo')])
    disconnectMonitor(graph)
    expect(source.connections.size).toBe(0)
    expect(splitter.disconnect).toHaveBeenCalledWith()
    expect(mergers[0].connections.size).toBe(0)
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


describe('effect resources and master selection', () => {
  const audioProject = () => ({ ...createEmptyProject(), tracks: [{ ...createTrack('audio'), id: 'input' }] })

  it('releases device internals once when a graph is retired', () => {
    const { context, nodes } = contextSpy()
    const dispose = vi.fn()
    vi.spyOn(EFFECT_MODULES.eq, 'create').mockImplementation((audio, remember) => {
      const input = remember(audio.createGain())
      return { input, output: input, update: vi.fn(), dispose }
    })
    const project = audioProject()
    project.tracks[0].devices = [createDevice('eq')]
    const graph = createGraph(context, project)
    const source = new AudioNodeSpy()
    connectMonitor(graph, source as unknown as MediaStreamAudioSourceNode, ['input'])
    const voiceDisconnect = vi.fn()
    graph.voices.add({ stop() { throw new Error('already closed') }, release() { throw new Error('already closed') }, disconnect: voiceDisconnect })
    disposeGraph(graph)
    disposeGraph(graph)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(voiceDisconnect).toHaveBeenCalledTimes(1)
    expect(graph.voices.size).toBe(0)
    expect(source.connections.size).toBe(0)
    expect(nodes.every(node => node.disconnect.mock.calls.length === 1)).toBe(true)
  })

  it('releases every connected node and created device if initial parameter application fails', () => {
    const { context, nodes } = contextSpy()
    const dispose = vi.fn()
    vi.spyOn(EFFECT_MODULES.eq, 'create').mockImplementation((audio, remember) => {
      const input = remember(audio.createGain())
      return { input, output: input, dispose, update() { throw new Error('invalid processor state') } }
    })
    const project = audioProject()
    project.tracks[0].devices = [createDevice('eq')]
    expect(() => createGraph(context, project)).toThrow('invalid processor state')
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(nodes.every(node => node.connections.size === 0 && node.disconnect.mock.calls.length === 1)).toBe(true)
  })

  it.each([
    { trackEnabled: true, deviceEnabled: false },
    { trackEnabled: false, deviceEnabled: true },
  ])('preserves the existing master with track=$trackEnabled and rig=$deviceEnabled', ({ trackEnabled, deviceEnabled }) => {
    const { context } = contextSpy()
    const project = audioProject()
    project.tracks[0].enabled = trackEnabled
    project.tracks[0].devices = [{ ...createDevice('guitar-rig'), enabled: deviceEnabled }]
    vi.spyOn(EFFECT_MODULES['guitar-rig'], 'create').mockImplementation((audio, remember) => {
      const input = remember(audio.createGain())
      return { input, output: input, update: vi.fn() }
    })
    const masterFactory = vi.spyOn(guitarRig, 'createGuitarRigMaster')
    const graph = createGraph(context, project)
    expect(masterFactory).not.toHaveBeenCalled()
    expect(context.createDynamicsCompressor).toHaveBeenCalledTimes(1)
    const compressor = vi.mocked(context.createDynamicsCompressor).mock.results[0].value!
    expect([compressor.threshold.value, compressor.knee.value, compressor.ratio.value, compressor.attack.value, compressor.release.value])
      .toEqual([-3, 3, 12, 0.003, 0.12])
    disposeGraph(graph)
  })

  it('invalidates a stopped graph when track enable changes its master, but preserves fader-only edits', () => {
    const track = { ...createTrack('audio'), devices: [createDevice('guitar-rig')] }
    const initial = trackLayoutKey([track])
    expect(trackLayoutKey([{ ...track, enabled: false }])).not.toBe(initial)
    expect(trackLayoutKey([{ ...track, mute: true }])).toBe(initial)
    expect(trackLayoutKey([{ ...track, solo: true, soloSafe: true }])).toBe(initial)
    expect(trackLayoutKey([{ ...track, volume: 0.3, pan: 0.5 }])).toBe(initial)
  })

  it('uses and disposes the causal master for an enabled guitar rig in either context type', () => {
    const masterDispose = vi.fn()
    const masterFactory = vi.spyOn(guitarRig, 'createGuitarRigMaster').mockImplementation((audio, remember) => {
      const input = remember(audio.createGain())
      return { input, output: input, update: vi.fn(), dispose: masterDispose }
    })
    vi.spyOn(EFFECT_MODULES['guitar-rig'], 'create').mockImplementation((audio, remember) => {
      const input = remember(audio.createGain())
      return { input, output: input, update: vi.fn() }
    })
    const project = audioProject()
    project.tracks[0].devices = [createDevice('guitar-rig')]
    // createGraph accepts BaseAudioContext, so live/offline construction takes the same branch.
    for (let contextNumber = 0; contextNumber < 2; contextNumber += 1) {
      const { context } = contextSpy()
      const graph = createGraph(context, project)
      expect(masterFactory).toHaveBeenLastCalledWith(context, expect.any(Function))
      expect(context.createDynamicsCompressor).not.toHaveBeenCalled()
      disposeGraph(graph)
    }
    expect(masterDispose).toHaveBeenCalledTimes(2)
  })
})

describe('piano key-release noise', () => {
  const releaseLibrary = (toneSeconds: number) => ({ get: () => ({
    ...sample,
    set: { ...sample.set, releaseZones: [{ file: 'rel', root: 60, lo: 0, hi: 127, vlo: 0, vhi: 1 }] },
    buffers: new Map([['tone', { duration: toneSeconds } as AudioBuffer], ['rel', { duration: 0.4 } as AudioBuffer]]),
  }) }) as unknown as SampleLibrary
  const run = (region: MidiClip, params?: Record<string, number>, toneSeconds = 4) => {
    const { context, sources } = contextSpy()
    const project = projectFor(region)
    if (params) project.tracks[0] = { ...project.tracks[0], instrumentParams: { ...project.tracks[0].instrumentParams, ...params } }
    const graph = createGraph(context, project)
    scheduleRange(graph, project, new Map(), 0, 4, 0, 4, true, false, releaseLibrary(toneSeconds))
    disposeGraph(graph)
    return sources
  }

  it('plays at note-off of a released note', () => {
    const sources = run(clip())
    expect(sources).toHaveLength(2)
    expect(sources[1].start.mock.calls[0][0]).toBeCloseTo((0.3 + 0.2) / 2)
  })

  it('is skipped when the note runs into the clip end, rang out, or the amount is 0', () => {
    expect(run(clip({ notes: [{ id: 'n', pitch: 60, start: 0.5, duration: 0.5, velocity: 0.8 }] }))).toHaveLength(1)
    expect(run(clip({ lengthBeats: 4, notes: [{ id: 'n', pitch: 60, start: 0, duration: 3, velocity: 0.8 }] }), undefined, 1)).toHaveLength(1)
    expect(run(clip(), { releaseNoise: 0 })).toHaveLength(1)
  })
})

describe('track-input routes (docs/TRACK_INPUT_ROUTING.md)', () => {
  const routedProject = (): Project => {
    const synth = { ...createTrack('instrument'), id: 'synth', name: '신스', devices: [createDevice('eq')] }
    const pre = { ...createTrack('audio'), id: 'pre', inputRoute: { kind: 'track' as const, trackId: 'synth', tap: 'preFx' as const } }
    const post = { ...createTrack('audio'), id: 'post', inputRoute: { kind: 'track' as const, trackId: 'synth', tap: 'postFx' as const } }
    const fader = { ...createTrack('audio'), id: 'fader', inputRoute: { kind: 'track' as const, trackId: 'synth', tap: 'postFader' as const } }
    const resample = { ...createTrack('audio'), id: 'resample', inputRoute: { kind: 'master' as const } }
    const downstream = { ...createTrack('audio'), id: 'downstream', inputRoute: { kind: 'track' as const, trackId: 'resample', tap: 'postFader' as const } }
    return { ...createEmptyProject(), masterVolume: 0.8, tracks: [pre, post, fader, resample, downstream, synth] }
  }

  it('connects each tap of the source into the routed input, behind a closed monitor gate', () => {
    const { context } = contextSpy()
    const graph = createGraph(context, routedProject())
    const synth = graph.tracks.get('synth')!
    const input = (id: string) => graph.routes.get(id)!.input as unknown as AudioNodeSpy
    expect((synth.input as unknown as AudioNodeSpy).connections.has(input('pre'))).toBe(true)
    expect((synth.postFx as unknown as AudioNodeSpy).connections.has(input('post'))).toBe(true)
    expect((synth.fader as unknown as AudioNodeSpy).connections.has(input('fader'))).toBe(true)
    // The route input reaches the track only through its monitor gate, closed until monitoring.
    const route = graph.routes.get('post')!
    expect((route.input as unknown as AudioNodeSpy).connections).toEqual(new Set([route.monitor]))
    expect((route.monitor as unknown as AudioNodeSpy).connections).toEqual(new Set([graph.tracks.get('post')!.input]))
    expect(route.monitor.gain.value).toBe(0)
    setRouteMonitoring(graph, ['post'])
    expect(route.monitor.gain.value).toBe(1)
    expect(graph.routes.get('pre')!.monitor.gain.value).toBe(0)
    setRouteMonitoring(graph, [])
    expect(route.monitor.gain.value).toBe(0)
  })

  it('feeds resampling from the master volume over every track except itself and its downstream', () => {
    const { context } = contextSpy()
    const graph = createGraph(context, routedProject())
    const volume = graph.resampleVolume as unknown as AudioNodeSpy
    expect(volume.gain.value).toBe(0.8)
    expect(volume.connections.has(graph.routes.get('resample')!.input)).toBe(true)
    const feed = [...graph.tracks.values()].map(track => track.fader as unknown as AudioNodeSpy).flatMap(fader => [...fader.connections])
      .find(node => (node as AudioNodeSpy).connections.has(volume)) as AudioNodeSpy
    const feeding = [...graph.tracks].filter(([, track]) => (track.fader as unknown as AudioNodeSpy).connections.has(feed)).map(([id]) => id).sort()
    expect(feeding).toEqual(['fader', 'post', 'pre', 'synth'])
    updateGraph(graph, { ...routedProject(), masterVolume: 0.5 }, false)
    expect(volume.gain.value).toBe(0.5)
  })

  it('rebuilds the graph when a route or tap changes and wires no loop or deleted source', () => {
    const project = routedProject()
    const retapped = { ...project, tracks: project.tracks.map(track => track.id === 'post' ? { ...track, inputRoute: { kind: 'track' as const, trackId: 'synth', tap: 'preFx' as const } } : track) }
    expect(trackLayoutKey(retapped.tracks)).not.toBe(trackLayoutKey(project.tracks))
    const a = { ...createTrack('audio'), id: 'a', inputRoute: { kind: 'track' as const, trackId: 'b', tap: 'postFx' as const } }
    const b = { ...createTrack('audio'), id: 'b', inputRoute: { kind: 'track' as const, trackId: 'a', tap: 'postFx' as const } }
    const orphan = { ...createTrack('audio'), id: 'orphan', inputRoute: { kind: 'track' as const, trackId: 'gone', tap: 'postFx' as const } }
    const { context } = contextSpy()
    const graph = createGraph(context, { ...createEmptyProject(), tracks: [a, b, orphan] })
    const into = (id: string) => [...graph.tracks.values()].some(track => (track.postFx as unknown as AudioNodeSpy).connections.has(graph.routes.get(id)!.input))
    // The loop is broken at its first member; b still hears a.
    expect(into('a')).toBe(false)
    expect((graph.tracks.get('a')!.postFx as unknown as AudioNodeSpy).connections.has(graph.routes.get('b')!.input)).toBe(true)
    expect(into('orphan')).toBe(false)
  })
})

describe('send/return buses (docs/SENDS_RETURNS.md)', () => {
  const sendProject = (devices = [createDevice('eq')]): Project => {
    const ret = { ...createTrack('return'), id: 'ret', soloSafe: true, devices }
    const keys = { ...createTrack('instrument'), id: 'keys', sends: [{ returnId: 'ret', level: 0.5 }] }
    const vox = { ...createTrack('audio'), id: 'vox', volume: 0.3, sends: [{ returnId: 'ret', level: 0.25, pre: true }] }
    return { ...createEmptyProject(), tracks: [ret, keys, vox] }
  }
  const spy = (node: unknown) => node as AudioNodeSpy

  it('taps post-fader sends from the fader and pre-fader sends from postFx into the return input', () => {
    const { context } = contextSpy()
    const graph = createGraph(context, sendProject())
    const ret = graph.tracks.get('ret')!, keys = graph.tracks.get('keys')!, vox = graph.tracks.get('vox')!
    const post = keys.sends.get('ret')!, pre = vox.sends.get('ret')!
    expect(post.pre).toBe(false)
    expect(spy(keys.fader).connections.has(post.gain)).toBe(true)
    expect(spy(keys.postFx).connections.has(post.gain)).toBe(false)
    expect(spy(vox.postFx).connections.has(pre.gain)).toBe(true)
    expect(spy(post.gain).connections).toEqual(new Set([ret.input]))
    expect(spy(pre.gain).connections).toEqual(new Set([ret.input]))
    expect(post.gain.gain.value).toBe(0.5)
    expect(pre.gain.gain.value).toBe(0.25)
    // The return itself is an ordinary channel into the master and has no sends.
    expect(ret.sends.size).toBe(0)
  })

  it('updates levels as parameters, silences pre-fader sends of unsoloed tracks, and keeps returns audible on solo', () => {
    const { context } = contextSpy()
    const project = sendProject()
    const graph = createGraph(context, project)
    const soloKeys = { ...project, tracks: project.tracks.map(track => track.id === 'keys' ? { ...track, solo: true, sends: [{ returnId: 'ret', level: 1 }] } : track) }
    expect(trackLayoutKey(soloKeys.tracks)).toBe(trackLayoutKey(project.tracks))
    updateGraph(graph, soloKeys, false)
    expect(graph.tracks.get('keys')!.sends.get('ret')!.gain.gain.value).toBe(1)
    expect(graph.tracks.get('vox')!.sends.get('ret')!.gain.gain.value).toBe(0)
    expect(graph.tracks.get('vox')!.fader.gain.value).toBe(0)
    expect(graph.tracks.get('ret')!.fader.gain.value).toBe(0.7)
    const flipped = { ...project, tracks: project.tracks.map(track => track.id === 'keys' ? { ...track, sends: [{ returnId: 'ret', level: 0.5, pre: true }] } : track) }
    expect(trackLayoutKey(flipped.tracks)).not.toBe(trackLayoutKey(project.tracks))
  })

  it('wires nothing for sends to missing returns and includes return tails after their senders', () => {
    const { context } = contextSpy()
    const lonely = { ...createTrack('audio'), id: 'lonely', sends: [{ returnId: 'gone', level: 1 }] }
    const graph = createGraph(context, { ...createEmptyProject(), tracks: [lonely] })
    expect(graph.tracks.get('lonely')!.sends.size).toBe(0)
    const project = sendProject([createDevice('reverb', { amount: 1, dry: 0 })])
    const reverbTail = EFFECT_MODULES.reverb.tailSeconds({ amount: 1, dry: 0, size: 0.35, tone: 9000, type: 0, predelay: 0, lowcut: 20 }, 120)
    // keys (release 0.3 s + 0.2) feeds the return, so the reverb rings on after the keys' own release.
    expect(renderTailSeconds(project)).toBeCloseTo(reverbTail + 0.5, 6)
  })
})

describe('tempo map × sends × controllers in the Web Audio graph', () => {
  const ramp = [{ beat: 0, bpm: 90, curve: 'ramp' as const }, { beat: 8, bpm: 150, curve: 'step' as const }]

  it('schedules pitch-bend events across a ramp at tempo-map times, through the track controller bus', () => {
    const { context, nodes } = contextSpy()
    const spyContext = context as unknown as Record<string, unknown>
    spyContext.createConstantSource = () => { const value = Object.assign(new AudioNodeSpy(), { offset: new Parameter() }); nodes.push(value); return value }
    spyContext.createOscillator = () => { const value = new AudioNodeSpy(); nodes.push(value); return value }
    const region = clip({ lengthBeats: 8, bendRange: 12, notes: [], controllers: { pitchBend: [{ beat: 2, value: 4096 }, { beat: 6, value: -8192 }] } })
    const project: Project = { ...projectFor(region), bpm: 90, tempoMap: ramp, lengthBeats: 12 }
    const graph = createGraph(context, project)
    const offset = (graph.tracks.get('track')!.controls!.bend as unknown as { offset: Parameter }).offset
    scheduleRange(graph, project, new Map(), 0, 12, 5, 12, false, false, library)
    const tempo = tempoMapOf(project)
    const calls = offset.setTargetAtTime.mock.calls.map(([value, time]) => [value, time])
    // Bend 4096 at beat 2 (+600 cents with a 12-semitone range), full down at beat 6, the reset at the region end (beat 8).
    expect(calls.map(([value]) => value)).toEqual([600, -1200, 0])
    calls.forEach(([, time], index) => expect(time).toBeCloseTo(5 + tempo.secondsAt([2, 6, 8][index]), 9))
    // Not constant-tempo times: the accelerating ramp brings beat 6 earlier than at 90 BPM.
    expect(calls[1][1]).toBeLessThan(5 + 6 * 60 / 90 - 0.1)
    disposeGraph(graph)
  })

  it('feeds sends into a return whose synced effects follow the tempo passed for the playhead', () => {
    const { context } = contextSpy()
    const device = createDevice('eq')
    const ret = { ...createTrack('return'), id: 'ret', devices: [device] }
    const keys = { ...createTrack('instrument'), id: 'keys', sends: [{ returnId: 'ret', level: 0.5 }] }
    const project: Project = { ...createEmptyProject(), bpm: 90, tempoMap: ramp, tracks: [ret, keys] }
    const graph = createGraph(context, project)
    const update = vi.fn()
    graph.tracks.get('ret')!.devices.set(device.id, { update } as never)
    const send = graph.tracks.get('keys')!.sends.get('ret')!.gain as unknown as AudioNodeSpy
    expect(send.connections.has(graph.tracks.get('ret')!.input)).toBe(true)
    const playhead = tempoMapOf(project).bpmAt(6)
    updateGraph(graph, project, false, 6) // the beat: bpm defaults to the tempo there
    expect(update).toHaveBeenLastCalledWith(device.params, playhead, 0, false)
    expect(playhead).toBeGreaterThan(90)
    disposeGraph(graph)
  })
})
