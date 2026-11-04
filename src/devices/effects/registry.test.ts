import { describe, expect, it, vi } from 'vitest'
import { COMMAND_METADATA } from '../../core/commands'
import { defaultParams } from '../../core/devices'
import { createDevice, createEmptyProject, createTrack, validateProject } from '../../core/project'
import type { Device, EffectType, Project } from '../../core/types'
import { createGraph, disposeGraph, renderTailSeconds } from '../../audio/graph'
import { EFFECT_DEFS, EFFECT_MODULES, EFFECT_TYPES } from './registry'

// Observe graph topology and Web Audio scheduling contracts; this is not an acoustic test.
class Parameter {
  constructor(public value = 0) {}
  cancelScheduledValues = vi.fn()
  setValueAtTime = vi.fn((value: number, _time: number) => { this.value = value })
  setTargetAtTime = vi.fn((value: number, _time: number, _constant: number) => { this.value = value })
}

class NodeSpy {
  connections = new Set<NodeSpy>()
  connect = vi.fn((node: NodeSpy) => { this.connections.add(node); return node })
  disconnect = vi.fn(() => { this.connections.clear() })
  gain = new Parameter(1)
  frequency = new Parameter()
  Q = new Parameter()
  pan = new Parameter()
  threshold = new Parameter()
  ratio = new Parameter()
  knee = new Parameter()
  attack = new Parameter()
  release = new Parameter()
  delayTime = new Parameter()
  type = ''
  fftSize = 256
  oversample = 'none'
  curve: Float32Array | null = null
  buffer: AudioBuffer | null = null
  constructor(readonly kind: string) {}
}

function contextSpy(sampleRate = 48000) {
  const nodes: NodeSpy[] = []
  const make = (kind: string) => { const node = new NodeSpy(kind); nodes.push(node); return node }
  const context = {
    currentTime: 2, sampleRate, destination: new NodeSpy('destination'),
    createGain: () => make('gain'),
    createBiquadFilter: () => make('filter'),
    createDynamicsCompressor: () => make('compressor'),
    createWaveShaper: () => make('shaper'),
    createDelay: () => make('delay'),
    createConvolver: () => make('convolver'),
    createStereoPanner: () => make('panner'),
    createAnalyser: () => make('analyser'),
    createBuffer: (channels: number, length: number, rate: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length))
      return { length, duration: length / rate, sampleRate: rate, numberOfChannels: channels, getChannelData: (channel: number) => data[channel] }
    },
  } as unknown as BaseAudioContext
  return { context, nodes }
}

function create(type: EffectType, sampleRate = 48000) {
  const { context, nodes } = contextSpy(sampleRate)
  const owned: AudioNode[] = []
  const effect = EFFECT_MODULES[type].create(context, node => { owned.push(node); return node })
  return { context, nodes, owned, effect }
}

function audioProject(devices: Device[]): Project {
  return { ...createEmptyProject(), bpm: 120, tracks: [{ ...createTrack('audio'), id: 'audio', devices }] }
}

describe('built-in effect modules share one catalog', () => {
  it('retains saved IDs, ordering, and original numeric defaults in UI and MCP', () => {
    expect(EFFECT_TYPES).toEqual(['eq', 'filter', 'compressor', 'drive', 'delay', 'reverb', 'guitar-rig'])
    expect(Object.fromEntries(EFFECT_TYPES.filter(type => type !== 'guitar-rig').map(type => [type, defaultParams(EFFECT_DEFS[type].params)]))).toEqual({
      eq: { low: 0, mid: 0, midFreq: 1000, high: 0 },
      filter: { cutoff: 1200, resonance: 0.7, mode: 0 },
      compressor: { threshold: -18, ratio: 4, attack: 10, release: 150, makeup: 0 },
      drive: { drive: 9, tone: 9000, mix: 1, output: 0 },
      delay: { amount: 0.3, time: 0.75, feedback: 0.32, tone: 3800 },
      reverb: { amount: 0.3, size: 0.35, tone: 9000 },
    })
    const command = COMMAND_METADATA.find(command => command.type === 'effect.add')!
    const schema = command.inputSchema.properties as Record<string, Record<string, unknown>>
    expect(schema.effectType.enum).toBe(EFFECT_TYPES)
    for (const type of EFFECT_TYPES) {
      expect(EFFECT_MODULES[type].id).toBe(type)
      expect(EFFECT_MODULES[type].definition).toBe(EFFECT_DEFS[type])
    }
  })

  it('round-trips existing numeric device state and bypass through project validation', () => {
    const devices = EFFECT_TYPES.map(type => createDevice(type))
    devices[0] = { ...devices[0], enabled: false, params: { ...devices[0].params, mid: -5.5 } }
    const project = audioProject(devices)
    const restored = validateProject(JSON.parse(JSON.stringify(project)))
    expect(restored.tracks[0].devices).toEqual(devices)
  })
})

describe('independent effect processing contracts', () => {
  // The worklet-backed guitar rig has separate lifecycle and rendering tests.
  it.each(EFFECT_TYPES.filter(type => type !== 'guitar-rig'))('%s gives the host ownership of every node it creates', type => {
    const { nodes, owned, effect } = create(type)
    effect.update({}, 120, 4, false)
    expect(owned).toEqual(nodes)
    expect(owned).toContain(effect.input)
    expect(owned).toContain(effect.output)
  })

  it('EQ retains its serial shelf/peak/shelf voicing and immediate initialization', () => {
    const { nodes, effect } = create('eq')
    effect.update({ low: -3, mid: 4, midFreq: 1500, high: 2 }, 120, 6, false)
    expect(nodes.map(node => node.type)).toEqual(['lowshelf', 'peaking', 'highshelf'])
    expect(nodes.map(node => node.frequency.value)).toEqual([220, 1500, 4500])
    expect(nodes[1].Q.value).toBe(0.9)
    expect(nodes[0].connections).toEqual(new Set([nodes[1]]))
    expect(nodes[1].connections).toEqual(new Set([nodes[2]]))
    expect(nodes[0].gain.setValueAtTime).toHaveBeenCalledWith(-3, 6)
    expect(nodes[0].gain.setTargetAtTime).not.toHaveBeenCalled()
  })

  it('filter keeps mode selection and sample-rate cutoff protection', () => {
    const { nodes, effect } = create('filter', 16000)
    effect.update({ mode: 2, cutoff: 20000, resonance: 4 }, 120, 9, true)
    expect(nodes[0].type).toBe('bandpass')
    expect(nodes[0].frequency.value).toBe(7200)
    expect(nodes[0].Q.value).toBe(4)
    expect(nodes[0].frequency.cancelScheduledValues).toHaveBeenCalledWith(9)
    expect(nodes[0].frequency.setTargetAtTime).toHaveBeenCalledWith(7200, 9, 0.012)
  })

  it('compressor converts milliseconds and makeup dB without changing the knee', () => {
    const { nodes, effect } = create('compressor')
    effect.update({ attack: 20, release: 250, makeup: 6, threshold: -24, ratio: 8 }, 120, 0, false)
    expect(nodes[0].knee.value).toBe(6)
    expect(nodes[0].attack.value).toBe(0.02)
    expect(nodes[0].release.value).toBe(0.25)
    expect(nodes[0].threshold.value).toBe(-24)
    expect(nodes[0].ratio.value).toBe(8)
    expect(nodes[1].gain.value).toBeCloseTo(1.99526231497)
    expect(nodes[0].connections).toEqual(new Set([nodes[1]]))
  })

  it('drive preserves its parallel dry/wet routing, compensation, and shaping endpoints', () => {
    const { nodes, effect } = create('drive')
    const [input, dry, pre, shaper, tone, post, wet, output] = nodes
    effect.update({ drive: 0, mix: 0.25, output: 0 }, 120, 0, false)
    expect(input.connections).toEqual(new Set([dry, pre]))
    expect(dry.connections).toEqual(new Set([output]))
    expect(pre.connections).toEqual(new Set([shaper]))
    expect(shaper.connections).toEqual(new Set([tone]))
    expect(tone.connections).toEqual(new Set([post]))
    expect(post.connections).toEqual(new Set([wet]))
    expect(wet.connections).toEqual(new Set([output]))
    expect(dry.gain.value).toBe(0.75)
    expect(wet.gain.value).toBe(0.25)
    expect(post.gain.value).toBeCloseTo(0.62869461346)
    expect(shaper.oversample).toBe('2x')
    expect(shaper.curve).toHaveLength(2048)
    expect(shaper.curve![0]).toBe(-1)
    expect(shaper.curve![2047]).toBe(1)
  })

  it('delay follows musical tempo and keeps feedback inside its own device', () => {
    const { nodes, effect } = create('delay')
    const [input, output, delay, wet, tone, feedback] = nodes
    effect.update({ time: 0.75, amount: 0.8, feedback: 0.6 }, 90, 3, true)
    expect(delay.delayTime.value).toBe(0.5)
    expect(wet.gain.value).toBeCloseTo(0.36)
    expect(feedback.gain.value).toBe(0.6)
    expect(input.connections).toEqual(new Set([output, delay]))
    expect(delay.connections).toEqual(new Set([wet, tone]))
    expect(tone.connections).toEqual(new Set([feedback]))
    expect(feedback.connections).toEqual(new Set([delay]))
    effect.update({ time: 0.75 }, 120, 4, false)
    expect(delay.delayTime.value).toBe(0.375)
  })

  it('reverb keeps deterministic context-local impulses and room blend', () => {
    const { context, nodes, effect } = create('reverb', 8000)
    effect.update({ size: 0.4, amount: 0.6 }, 120, 0, false)
    const [, , small, large, smallGain, largeGain, , wet] = nodes
    expect(small.buffer!.length).toBe(13600)
    expect(large.buffer!.length).toBe(33600)
    expect(small.buffer!.numberOfChannels).toBe(2)
    expect(small.buffer!.getChannelData(0)[0]).toBeCloseTo(0.5898486971855164)
    expect(large.buffer!.getChannelData(0)[0]).toBeCloseTo(-0.9171622395515442)
    expect(smallGain.gain.value).toBe(0.6)
    expect(largeGain.gain.value).toBe(0.4)
    expect(wet.gain.value).toBe(0.3)
    const next: AudioNode[] = []
    EFFECT_MODULES.reverb.create(context, node => { next.push(node); return node })
    expect((next[2] as ConvolverNode).buffer).toBe(small.buffer)
    expect((next[3] as ConvolverNode).buffer).toBe(large.buffer)
    const another = create('reverb', 8000)
    expect(another.nodes[2].buffer).not.toBe(small.buffer)
    expect(another.nodes[2].buffer!.getChannelData(0)).toEqual(small.buffer!.getChannelData(0))
  })
})

describe('host integration of effect modules', () => {
  it('connects the enabled modules in saved order and releases all host-owned nodes', () => {
    const { context, nodes } = contextSpy(8000)
    const eq = createDevice('eq'), bypass = { ...createDevice('filter'), enabled: false }, drive = createDevice('drive')
    const graph = createGraph(context, audioProject([eq, bypass, drive]))
    const track = graph.tracks.get('audio')!
    expect([...track.devices.keys()]).toEqual([eq.id, drive.id])
    expect((track.input as unknown as NodeSpy).connections).toEqual(new Set([track.devices.get(eq.id)!.input]))
    expect((track.devices.get(eq.id)!.output as unknown as NodeSpy).connections).toEqual(new Set([track.devices.get(drive.id)!.input]))
    expect((track.devices.get(drive.id)!.output as unknown as NodeSpy).connections).toEqual(new Set([track.panner]))
    expect(graph.nodes).toEqual(nodes)
    disposeGraph(graph)
    for (const node of nodes) expect(node.disconnect).toHaveBeenCalledExactlyOnceWith()
  })

  it('uses module tail estimates with tempo, bypass, and disabled-track guards', () => {
    const delay = createDevice('delay', { time: 1, feedback: 0.5, amount: 1 })
    const project = audioProject([delay])
    expect(renderTailSeconds(project)).toBeCloseTo(6.35)
    expect(renderTailSeconds({ ...project, bpm: 60 })).toBeCloseTo(11.85)
    expect(renderTailSeconds(audioProject([{ ...delay, enabled: false }]))).toBe(0.85)
    expect(renderTailSeconds({ ...project, tracks: [{ ...project.tracks[0], enabled: false }] })).toBe(0.85)
    expect(renderTailSeconds(audioProject([createDevice('reverb', { amount: 1, size: 1 })]))).toBeCloseTo(5.05)
    expect(renderTailSeconds(audioProject([createDevice('reverb', { amount: 0 })]))).toBe(0.85)
  })
})
