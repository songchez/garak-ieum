import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { instantiateGarakWasm, type RustGuitarRig } from './garakWasm'
import { createRustRigKernel, rigStructureKey } from './guitarRigRust'
import { GUITAR_RIG_PARAMS } from '../../devices/guitar-rig/definition'

// The guitar rig on the web's Rust core (garak-dsp.wasm, `pnpm rust:wasm`) against the desktop's: `cargo test
// -p garak-ffi` renders the parity scene with the native platform math and writes it to rust/target/rig-parity/
// (rust/garak-ffi/src/rig.rs). Without either artifact the suite is skipped (CI's rust.yml builds both).
const artifact = fileURLToPath(new URL('../../../public/wasm/garak-dsp.wasm', import.meta.url))
const dir = new URL('../../../rust/target/rig-parity/', import.meta.url)
const sceneFiles = ['scene.json', 'input.f32', 'native.f32', 'tap.f32'].map(f => fileURLToPath(new URL(f, dir)))
const built = existsSync(artifact)
const module = built ? new WebAssembly.Module(readFileSync(artifact)) : null
const hasRig = module ? instantiateGarakWasm(module).hasGuitarRig() : false

function floats(path: string): Float32Array {
  const bytes = readFileSync(path)
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}
const residualDb = (a: Float32Array, b: Float32Array) => {
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff = Math.max(diff, Math.abs(a[i] - b[i]))
  return diff > 0 ? 20 * Math.log10(diff) : -Infinity
}

interface Scene { sampleRate: number; block: number; blocks: number; steps: { block: number; kind: 'create' | 'configure' | 'rebuild'; params: Record<string, number> }[] }

describe.skipIf(!hasRig || !sceneFiles.every(f => existsSync(f)))('guitar rig: web (WASM) vs desktop (native Rust)', () => {
  it('renders the parity scene like the desktop rig, tuner tap included', () => {
    const scene = JSON.parse(readFileSync(sceneFiles[0], 'utf8')) as Scene
    const input = floats(sceneFiles[1]), native = floats(sceneFiles[2]), nativeTap = floats(sceneFiles[3])
    // Kernels from a main-thread instance, the rig in another (the worklet's split).
    const main = instantiateGarakWasm(module!)
    const kernels = (params: Record<string, number>) => main.rigReverbDecays(params).map(d => d === null ? null : main.buildReverbKernels(scene.sampleRate, 0, d))
    const worklet = instantiateGarakWasm(module!)
    const first = scene.steps[0].params
    let rig: RustGuitarRig = worklet.createGuitarRig(scene.sampleRate, first, kernels(first))!
    expect(rig).not.toBeNull()
    const { block, blocks } = scene
    const out = new Float32Array(blocks * block * 2), tapOut = new Float32Array(blocks * block)
    const l = new Float32Array(block), r = new Float32Array(block), tap = new Float32Array(block)
    for (let b = 0; b < blocks; b += 1) {
      for (const step of scene.steps.slice(1)) {
        if (step.block !== b) continue
        if (step.kind === 'configure') rig.configure(step.params)
        else {
          const next = worklet.createGuitarRig(scene.sampleRate, step.params, kernels(step.params))!
          next.takeStateFrom(rig)
          rig.free()
          rig = next
        }
      }
      for (let i = 0; i < block; i += 1) { l[i] = input[2 * (b * block + i)]; r[i] = input[2 * (b * block + i) + 1] }
      rig.process(l, r, block, tap)
      for (let i = 0; i < block; i += 1) { out[2 * (b * block + i)] = l[i]; out[2 * (b * block + i) + 1] = r[i] }
      tapOut.set(tap, b * block)
    }
    rig.free()
    const audio = residualDb(out, native), tuner = residualDb(tapOut, nativeTap)
    console.info(`guitar rig WASM vs native: residual ${audio === -Infinity ? 'bit-identical' : `${audio.toFixed(1)} dBFS`}, tuner tap ${tuner === -Infinity ? 'bit-identical' : `${tuner.toFixed(1)} dBFS`}`)
    expect(audio).toBeLessThanOrEqual(-90)
    expect(tuner).toBeLessThanOrEqual(-90)
    expect(worklet.heapBytes().used).toBeLessThan(64 * 1024)
  })
})

describe.skipIf(!hasRig)('guitar rig on the Rust core (worklet adapter and processor)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the same catalog as the TypeScript definition', () => {
    const defs = instantiateGarakWasm(module!).rigParamDefs()
    expect(defs.map(d => d.id).sort()).toEqual(GUITAR_RIG_PARAMS.map(d => d.id).sort())
    for (const def of defs) {
      const ts = GUITAR_RIG_PARAMS.find(p => p.id === def.id)!
      expect([def.default, def.min, def.max]).toEqual([ts.default, ts.min, ts.max])
    }
  })

  it('keeps structure apart from knobs and hands state over on rebuild', () => {
    const defs = instantiateGarakWasm(module!).rigParamDefs()
    expect(rigStructureKey({ ampGain: 30 }, defs)).toBe(rigStructureKey({}, defs))
    expect(rigStructureKey({ rackSlot3: 0 }, defs)).not.toBe(rigStructureKey({}, defs))
    expect(rigStructureKey({ reverbDecay_2: 0.9 }, defs)).not.toBe(rigStructureKey({}, defs))
    const kernel = createRustRigKernel(module!, 48000, { chorusEnabled: 1, delayEnabled: 1 })!
    expect(kernel.latencyFrames()).toBe(16)
    const l = new Float32Array(256).map((_, i) => Math.sin(i * 0.05) * 0.5), r = l.slice()
    kernel.process(l, r, 256)
    kernel.rebuild({ chorusEnabled: 1, delayEnabled: 1, driveEnabled: 1, rackSlot4: 6, rackSlot5: 5 })
    expect(kernel.latencyFrames()).toBe(24)
    kernel.configure({ chorusEnabled: 1, delayEnabled: 1, driveEnabled: 0, rackSlot4: 6, rackSlot5: 5 })
    expect(kernel.latencyFrames()).toBe(16)
    kernel.process(l, r, 256)
    expect([...l, ...r].every(Number.isFinite)).toBe(true)
    expect(kernel.tailSeconds()).toBeGreaterThan(0.04)
    kernel.free()
    kernel.process(l, r, 256)  // ignored after free
  })

  it('runs as the garak-guitar-rig-v1 processor: rig output, tuner tap, rebuild, dispose', async () => {
    const constructors = new Map<string, new (options?: unknown) => { port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void }; process(i: Float32Array[][], o: Float32Array[][], p?: Record<string, Float32Array>): boolean }>()
    const posted: unknown[] = []
    vi.stubGlobal('sampleRate', 48000)
    vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null, postMessage: (m: unknown) => posted.push(m) } })
    vi.stubGlobal('registerProcessor', (name: string, factory: never) => constructors.set(name, factory))
    await import('../../devices/guitar-rig/processors.worklet')
    const Processor = constructors.get('garak-guitar-rig-v1')!
    // A rack holding only the tuner: off it passes the signal, engaged it mutes.
    const tuner = { rackSlot0: 11, rackSlot1: 0, rackSlot2: 0, rackSlot3: 0, rackSlot4: 0, rackSlot5: 0, tunerEnabled: 0 }
    const processor = new Processor({ processorOptions: { garakWasm: module, params: tuner } })
    expect(posted).toContainEqual({ type: 'backend', rust: true, latency: 0 })
    const signal = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.1) * 0.4)
    const out = [[new Float32Array(128), new Float32Array(128)], [new Float32Array(128)]]
    expect(processor.process([[signal, signal]], out)).toBe(true)
    // The tuner sits first: the tap is the input itself.
    expect(Array.from(out[1][0])).toEqual(Array.from(signal))
    expect(Array.from(out[0][0])).toEqual(Array.from(signal))
    processor.port.onmessage!({ data: { type: 'rebuild', params: { ...tuner, tunerEnabled: 1 } } })
    processor.process([[signal, signal]], out)
    expect(out[0][0].every(v => v === 0)).toBe(true)
    processor.port.onmessage!({ data: { type: 'dispose' } })
    expect(processor.process([[signal, signal]], out)).toBe(false)
    // Without a module the processor reports it and passes audio through.
    const bare = new Processor({ processorOptions: {} })
    expect(posted).toContainEqual({ type: 'backend', rust: false, latency: 0 })
    bare.process([[signal, signal]], out)
    expect(Array.from(out[0][0])).toEqual(Array.from(signal))
  })

  it('is the web rig whenever the module has it: one node, rebuilds on structural edits, Web Audio fallback', async () => {
    const bytes = readFileSync(artifact)
    vi.stubGlobal('fetch', async () => new Response(bytes))
    class Param { value = 0; cancelScheduledValues() {} setValueAtTime(v: number) { this.value = v } setTargetAtTime(v: number) { this.value = v } }
    class Node {
      gain = new Param(); frequency = new Param(); Q = new Param(); delayTime = new Param(); parameters = new Map<string, Param>()
      type = ''; curve: Float32Array | null = null; oversample = 'none'; normalize = true; buffer: unknown = null; fftSize = 2048
      connections: unknown[][] = []
      connect(node: unknown, ...rest: unknown[]) { this.connections.push([node, ...rest]); return node }
      disconnect() { this.connections = [] }
      onprocessorerror: (() => void) | null = null
      port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((e: { data: unknown }) => void) | null }
    }
    const worklets: { name: string; options: AudioWorkletNodeOptions; node: Node }[] = []
    vi.stubGlobal('AudioWorkletNode', class extends Node {
      constructor(_context: unknown, name: string, options: AudioWorkletNodeOptions) {
        super()
        this.parameters = new Map(['sustain', 'attack', 'level', 'enabled', 'rate', 'depth', 'mix', 'feedback', 'shape'].map(k => [k, new Param()]))
        worklets.push({ name, options, node: this })
      }
    })
    const make = () => new Node()
    const context = {
      sampleRate: 48000, currentTime: 0, audioWorklet: { addModule: vi.fn(async () => undefined) }, dispatchEvent: vi.fn(),
      createGain: make, createBiquadFilter: make, createWaveShaper: make, createDelay: make, createConvolver: make, createAnalyser: make,
      createBuffer: vi.fn((channels: number, length: number) => ({ channels, length, copyToChannel: vi.fn() })),
    } as unknown as BaseAudioContext
    const { guitarRigEffect, prepareGuitarRig, guitarRigBackendStats } = await import('../../devices/guitar-rig/index')
    await prepareGuitarRig(context)
    const graph = guitarRigEffect.create(context, node => node) as ReturnType<typeof guitarRigEffect.create> & { tunerTap: unknown; dispose(): void }
    expect(worklets).toHaveLength(0)
    const params = { reverbEnabled: 1, rackSlot6: 10 }
    graph.update(params, 120, 0, false)
    expect(worklets.map(w => w.name)).toEqual(['garak-guitar-rig-v1'])
    const rig = worklets[0]
    expect(rig.options.numberOfOutputs).toBe(2)
    const init = rig.options.processorOptions as { garakWasm: unknown; params: Record<string, number>; kernels: (Float32Array | null)[] }
    expect(init.garakWasm).toBeInstanceOf(WebAssembly.Module)
    expect(init.kernels[0]).toBeInstanceOf(Float32Array)
    expect(init.kernels.slice(1)).toEqual([null, null])
    // A knob: params only. A rack edit: params, then a rebuild with the new rack.
    graph.update({ ...params, ampGain: 20 }, 120, 1, true)
    expect(rig.node.port.postMessage.mock.calls.map(c => (c[0] as { type: string }).type)).toEqual(['params'])
    graph.update({ ...params, ampGain: 20, rackSlot1: 0 }, 120, 2, true)
    expect(rig.node.port.postMessage.mock.calls.map(c => (c[0] as { type: string }).type)).toEqual(['params', 'params', 'rebuild'])
    // Automation glides in place, never rebuilds.
    graph.schedule!([{ at: 3, params: { ...params, rackSlot1: 2 } }], 120)
    expect(rig.node.port.postMessage.mock.calls.at(-1)![0]).toMatchObject({ type: 'schedule' })
    rig.node.port.onmessage!({ data: { type: 'backend', rust: true } })
    expect(guitarRigBackendStats.rust).toBe(1)
    // A worklet that could not create the Rust rig: the Web Audio rig takes over between the same ports.
    rig.node.port.onmessage!({ data: { type: 'backend', rust: false } })
    expect(worklets.length).toBeGreaterThan(1)
    expect(worklets.slice(1).every(w => w.name.startsWith('garak-guitar-') && w.name !== 'garak-guitar-rig-v1')).toBe(true)
    graph.update({ ...params, compEnabled: 0 }, 120, 4, false)
    graph.dispose()
    expect(rig.node.port.close).toHaveBeenCalled()
  })
})
