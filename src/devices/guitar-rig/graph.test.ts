import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertGuitarRigHealthy, createGuitarRigMaster, guitarRigEffect, prepareGuitarRig } from './index'
import { GUITAR_RIG_DEFAULTS, GUITAR_RIG_PARAMS } from './definition'

class Parameter {
  constructor(public value = 0) {}
  cancelScheduledValues() {}
  setValueAtTime(value: number) { this.value = value }
  setTargetAtTime(value: number) { this.value = value }
}
class Node {
  gain = new Parameter(1)
  frequency = new Parameter(350)
  Q = new Parameter(1)
  delayTime = new Parameter(0)
  parameters = new Map<string, Parameter>()
  type = ''
  curve: Float32Array | null = null
  oversample = 'none'
  connections = new Set<Node>()
  connect(node: Node) { this.connections.add(node); return node }
  disconnect() { this.connections.clear() }
  onprocessorerror: (() => void) | null = null
  port = { postMessage: vi.fn(), close: vi.fn() }
}
function setup() {
  const nodes: Node[] = []
  const worklets: Node[] = []
  const make = () => { const node = new Node(); nodes.push(node); return node }
  vi.stubGlobal('AudioWorkletNode', class extends Node {
    constructor() {
      super()
      this.parameters = new Map(['sustain', 'attack', 'level', 'enabled', 'rate', 'depth', 'mix'].map(key => [key, new Parameter()]))
      worklets.push(this); nodes.push(this)
    }
  })
  const context = {
    sampleRate: 48000,
    currentTime: 0,
    audioWorklet: { addModule: vi.fn(async (_url: string) => undefined) },
    dispatchEvent: vi.fn(),
    createGain: make,
    createBiquadFilter: make,
    createWaveShaper: make,
    createDelay: make,
  }
  return { context: context as unknown as BaseAudioContext, raw: context, nodes, worklets }
}
const snapshot = (nodes: Node[]) => nodes.map(n => [n.gain.value, n.frequency.value, n.Q.value, n.delayTime.value, ...[...n.parameters.values()].map(p => p.value)])
afterEach(() => vi.unstubAllGlobals())

describe('guitar rig Web Audio integration', () => {
  it('requires successful per-context preparation, caches it, and retries registration failure', async () => {
    const { context, raw } = setup()
    expect(() => guitarRigEffect.create(context, node => node)).toThrow('prepareGuitarRig')
    raw.audioWorklet.addModule.mockRejectedValueOnce(new Error('registration failed'))
    await expect(prepareGuitarRig(context)).rejects.toThrow('registration failed')
    expect(() => guitarRigEffect.create(context, node => node)).toThrow('prepareGuitarRig')
    await prepareGuitarRig(context)
    await prepareGuitarRig(context)
    expect(raw.audioWorklet.addModule).toHaveBeenCalledTimes(2)
    const moduleUrl = raw.audioWorklet.addModule.mock.calls[1][0]
    expect(String(moduleUrl)).not.toMatch(/^blob:/)
  })
  it('binds every saved control to an audio parameter and gives host all node ownership', async () => {
    const { context, nodes, worklets } = setup()
    await guitarRigEffect.prepare!(context)
    const owned: AudioNode[] = []
    const graph = guitarRigEffect.create(context, node => { owned.push(node); return node })
    expect(owned).toEqual(nodes)
    expect(owned).toContain(graph.input)
    expect(owned).toContain(graph.output)
    const allOn: Record<string, number> = { ...GUITAR_RIG_DEFAULTS, compEnabled: 1, driveEnabled: 1, chorusEnabled: 1, delayEnabled: 1 }
    for (const def of GUITAR_RIG_PARAMS) {
      graph.update(allOn, 120, 0, false)
      const initial = snapshot(nodes)
      graph.update({ ...allOn, [def.id]: allOn[def.id] === def.max ? def.min : def.max }, 120, 0, false)
      expect(snapshot(nodes), `${def.id} must change an actual DSP parameter`).not.toEqual(initial)
    }
    expect(nodes.filter(n => n.curve).map(n => n.oversample)).toEqual(['2x', '2x', '2x'])
    expect(worklets).toHaveLength(2)
    graph.dispose!()
  })
  it('releases worklet lifetime exactly once; later updates cannot reactivate the graph', async () => {
    const { context, nodes, worklets } = setup()
    await prepareGuitarRig(context)
    const graph = guitarRigEffect.create(context, node => node)
    graph.update(GUITAR_RIG_DEFAULTS, 120, 0, false)
    graph.dispose!(); graph.dispose!()
    for (const worklet of worklets) {
      expect(worklet.port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'dispose' })
      expect(worklet.port.close).toHaveBeenCalledTimes(1)
      expect(worklet.onprocessorerror).toBeNull()
    }
    const disposedState = snapshot(nodes)
    graph.update({ ...GUITAR_RIG_DEFAULTS, delayEnabled: 1 }, 120, 1, false)
    expect(snapshot(nodes)).toEqual(disposedState)
  })
  it('releases already-created worklets when another node fails during construction', async () => {
    const { context, raw, worklets } = setup()
    await prepareGuitarRig(context)
    raw.createBiquadFilter = () => { throw new Error('context closed') }
    expect(() => guitarRigEffect.create(context, node => node)).toThrow('context closed')
    for (const worklet of worklets) expect(worklet.port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'dispose' })
  })
  it('exposes processing failures to live context listeners and offline export guards', async () => {
    const { context, raw, worklets } = setup()
    await prepareGuitarRig(context)
    const master = createGuitarRigMaster(context, node => node)
    expect(() => assertGuitarRigHealthy(context)).not.toThrow()
    worklets[0].onprocessorerror!()
    expect(raw.dispatchEvent).toHaveBeenCalledTimes(1)
    expect(() => assertGuitarRigHealthy(context)).toThrow('오디오 처리 중 오류')
    master.dispose!()
  })
  it('estimates delay and chorus tail only when those sections are audible', () => {
    expect(guitarRigEffect.tailSeconds(GUITAR_RIG_DEFAULTS, 120)).toBe(0)
    expect(guitarRigEffect.tailSeconds({ ...GUITAR_RIG_DEFAULTS, chorusEnabled: 1 }, 120)).toBe(0.04)
    const tail = guitarRigEffect.tailSeconds({ ...GUITAR_RIG_DEFAULTS, delayEnabled: 1, delayTime: 500, delayFeedback: 0.5 }, 120)
    expect(tail).toBeCloseTo(5.7)
    expect(guitarRigEffect.tailSeconds({ ...GUITAR_RIG_DEFAULTS, delayEnabled: 1, delayMix: 0 }, 120)).toBe(0)
    const longTail = guitarRigEffect.tailSeconds({ ...GUITAR_RIG_DEFAULTS, delayEnabled: 1, delayTime: 1200, delayFeedback: 0.85 }, 120)
    expect(Math.pow(0.85, Math.floor((longTail - 0.2) / 1.2) - 1)).toBeLessThanOrEqual(0.001)
  })
})
