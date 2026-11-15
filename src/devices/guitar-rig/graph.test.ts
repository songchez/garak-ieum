import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertGuitarRigHealthy, bindGuitarRigDevice, createGuitarRigMaster, guitarRigEffect, guitarTunerTap, prepareGuitarRig } from './index'
import { GUITAR_RIG_DEFAULTS, GUITAR_RIG_MODULE_PARAMS, GUITAR_RIG_MODULES, GUITAR_RIG_PARAMS, guitarRigMaxInstances, guitarRigOrderParams, rigParam, rigSlotKey } from './definition'

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
  normalize = true
  buffer: unknown = null
  fftSize = 2048
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
      this.parameters = new Map(['sustain', 'attack', 'level', 'enabled', 'rate', 'depth', 'mix', 'feedback', 'shape'].map(key => [key, new Parameter()]))
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
    createConvolver: make,
    createAnalyser: make,
    createBuffer: vi.fn((channels: number, length: number) => ({ channels, length, copyToChannel: vi.fn() })),
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
    const allOn: Record<string, number> = { ...GUITAR_RIG_DEFAULTS, compEnabled: 1, driveEnabled: 1, chorusEnabled: 1, delayEnabled: 1, fuzzEnabled: 1, phaserEnabled: 1, tremoloEnabled: 1, reverbEnabled: 1 }
    for (const id of GUITAR_RIG_MODULES.map(m => m.id)) for (let instance = 1; instance < guitarRigMaxInstances(id); instance += 1) if (id !== 'tuner') allOn[rigParam(GUITAR_RIG_MODULE_PARAMS[id][0], instance)] = 1
    // Every control, including a second or third copy's, must reach the DSP once its module is racked.
    // Rack slots change the wiring, not a parameter value; they are covered by the rewiring test below.
    for (const def of GUITAR_RIG_PARAMS.filter(d => !d.id.startsWith('rackSlot'))) {
      const [, base, copy] = /^(.+?)(?:_(\d+))?$/.exec(def.id)!
      const id = GUITAR_RIG_MODULES.find(m => GUITAR_RIG_MODULE_PARAMS[m.id].includes(base))!.id
      const params = { ...allOn, ...guitarRigOrderParams([rigSlotKey(id, copy ? Number(copy) - 1 : 0)]) }
      graph.update(params, 120, 0, false)
      const initial = snapshot(nodes)
      graph.update({ ...params, [def.id]: params[def.id] === def.max ? def.min : def.max }, 120, 0, false)
      expect(snapshot(nodes), `${def.id} must change an actual DSP parameter`).not.toEqual(initial)
    }
    // Each racked copy owns its own shapers and worklets: 3 drives, 3 amps (2 shapers each), 3 fuzzes;
    // 3 each of compressor, chorus, phaser and tremolo.
    expect(nodes.filter(n => n.curve).map(n => n.oversample)).toEqual(Array(12).fill('2x'))
    expect(worklets).toHaveLength(12)
    expect(owned).toEqual(nodes)
    graph.dispose!()
  })
  it('rewires the chain in the user-arranged rack order and skips removed modules', async () => {
    const { context, nodes } = setup()
    await prepareGuitarRig(context)
    const graph = guitarRigEffect.create(context, node => node)
    const connections = () => nodes.map(n => [...(n as unknown as { connections: Set<unknown> }).connections].map(target => nodes.indexOf(target as never)).sort((a, b) => a - b).join(','))
    graph.update(GUITAR_RIG_DEFAULTS, 120, 0, false)
    const before = connections()
    graph.update({ ...GUITAR_RIG_DEFAULTS, ...guitarRigOrderParams(['delay', 'amp', 'cabinet']) }, 120, 0, false)
    const after = connections()
    expect(after).not.toEqual(before)
    // The same order again must not tear down and rebuild the connections.
    graph.update({ ...GUITAR_RIG_DEFAULTS, ...guitarRigOrderParams(['delay', 'amp', 'cabinet']) }, 120, 0, false)
    expect(connections()).toEqual(after)
    expect(guitarRigEffect.tailSeconds!({ ...GUITAR_RIG_DEFAULTS, delayEnabled: 1, ...guitarRigOrderParams(['amp', 'cabinet']) }, 120)).toBe(0)
    graph.dispose!()
  })
  it('places the new pedals only when they are in the rack and leaves the default rack unchanged', async () => {
    const { context, nodes, raw } = setup()
    await prepareGuitarRig(context)
    const graph = guitarRigEffect.create(context, node => node)
    const connections = () => nodes.map(n => [...n.connections].map(target => nodes.indexOf(target)).sort((a, b) => a - b).join(','))
    graph.update(GUITAR_RIG_DEFAULTS, 120, 0, false)
    const defaults = connections()
    // Switching new pedals on without putting them in the rack must not touch the routing.
    graph.update({ ...GUITAR_RIG_DEFAULTS, fuzzEnabled: 1, phaserEnabled: 1, tremoloEnabled: 1, reverbEnabled: 1, tunerEnabled: 1 }, 120, 0, false)
    expect(connections()).toEqual(defaults)
    // The reverb IR is generated lazily: only once the reverb is in the rack and on.
    expect(raw.createBuffer).not.toHaveBeenCalled()
    for (const order of [['fuzz', 'amp'], ['phaser', 'tremolo'], ['reverb'], ['tuner', 'amp', 'cabinet']] as const) {
      graph.update({ ...GUITAR_RIG_DEFAULTS, reverbEnabled: 1, ...guitarRigOrderParams(order) }, 120, 0, false)
      expect(connections()).not.toEqual(defaults)
    }
    expect(raw.createBuffer).toHaveBeenCalledTimes(2)
    expect(nodes.filter(n => n.buffer).length).toBe(2)
    expect(nodes.filter(n => n.buffer).every(n => n.normalize === false)).toBe(true)
    graph.dispose!()
  })
  it('mutes the rig output while the tuner is engaged and exposes its tap to the editor', async () => {
    const { context, nodes } = setup()
    await prepareGuitarRig(context)
    const graph = guitarRigEffect.create(context, node => node)
    graph.update({ ...GUITAR_RIG_DEFAULTS, ...guitarRigOrderParams(['tuner', 'amp']) }, 120, 0, false)
    const open = snapshot(nodes)
    graph.update({ ...GUITAR_RIG_DEFAULTS, tunerEnabled: 1, ...guitarRigOrderParams(['tuner', 'amp']) }, 120, 0, false)
    const changed = snapshot(nodes).map((values, i) => values.some((value, j) => value !== open[i][j]) ? i : -1).filter(i => i >= 0)
    // Exactly one gain moves, and it moves to zero: the tuner's pass-through.
    expect(changed).toHaveLength(1)
    expect(nodes[changed[0]].gain.value).toBe(0)
    bindGuitarRigDevice(graph, 'rig-1', context)
    expect(guitarTunerTap('rig-1')?.sampleRate).toBe(48000)
    // An offline export graph never replaces the live tap.
    bindGuitarRigDevice(guitarRigEffect.create(context, node => node), 'rig-1', { ...context, startRendering() {} } as unknown as BaseAudioContext)
    expect(guitarTunerTap('rig-1')).toBe((graph as unknown as { tunerTap: unknown }).tunerTap)
    graph.dispose!()
    expect(guitarTunerTap('rig-1')).toBeUndefined()
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
    // Reverb rings for its long IR (matching the native engine) only when it is in the rack, on and mixed in.
    const verb = { ...GUITAR_RIG_DEFAULTS, reverbEnabled: 1, ...guitarRigOrderParams(['amp', 'cabinet', 'reverb']) }
    expect(guitarRigEffect.tailSeconds(verb, 120)).toBeCloseTo(4.45)
    expect(guitarRigEffect.tailSeconds({ ...verb, reverbDecay: 0 }, 120)).toBeCloseTo(1.95)
    expect(guitarRigEffect.tailSeconds({ ...verb, reverbMix: 0 }, 120)).toBe(0)
    expect(guitarRigEffect.tailSeconds({ ...GUITAR_RIG_DEFAULTS, reverbEnabled: 1 }, 120)).toBe(0)
  })
})
