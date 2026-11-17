import type { DeviceGraph, RealtimeEffectModule, RememberNode } from '../contracts.js'
import { kernelTailSeconds } from './kernels.js'
import { KERNEL_DEFS, type KernelType } from './sigimsaeDefs.js'
import type { DynamicsMeterSource, DynamicsReading } from './dynamicsMeter.js'
import { createAnalysisTap, createStereoScopeTap, unbindDeviceAnalysis, type DeviceAnalysisTap } from './analysis.js'
import { rustDspRequested } from '../../audio/rust/flag.js'
import { instantiateGarakWasm, sharedGarakWasmModule, type GarakWasm, type RustEffectType } from '../../audio/rust/garakWasm.js'
import { clamp } from '../../audio/math.js'

/** Kernels that report input level and gain reduction to the device views. */
const METERED: ReadonlySet<RustEffectType> = new Set<RustEffectType>(['limiter', 'gate', 'compressor'])

const prepared = new WeakMap<BaseAudioContext, Promise<void>>()
const ready = new WeakSet<BaseAudioContext>()
/** Rust/WASM kernels (docs/RUST.md): the compiled module per context when it loaded, else absent (TS / Web Audio fallback). */
const rustModules = new WeakMap<BaseAudioContext, WebAssembly.Module>()
const baseUrl = () => (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'

/** Fetched and compiled once per page: every context (playback, exports) gets the same module. */
let moduleLoad: Promise<WebAssembly.Module | null> | null = null
function garakModule(): Promise<WebAssembly.Module | null> {
  if (!rustDspRequested()) return Promise.resolve(null)
  moduleLoad ??= sharedGarakWasmModule(baseUrl()).then(module => {
    if (!module) console.info('[가락이음] Rust DSP 모듈(wasm/garak-dsp.wasm)이 없거나 불러오지 못해 TypeScript 커널과 Web Audio 노드로 처리합니다. 만들려면: pnpm rust:wasm (docs/RUST.md)')
    return module
  })
  return moduleLoad
}

/** Which path the worklet nodes took (diagnostics; also read by the browser smoke check). */
export const rustDspStats = { rust: 0, fallback: 0 }
;(globalThis as { __garakRustDsp?: typeof rustDspStats }).__garakRustDsp = rustDspStats

/** Registers the shared 시김새 processor once per realtime or offline context. */
export function prepareSigimsae(context: BaseAudioContext): Promise<void> {
  const existing = prepared.get(context)
  if (existing) return existing
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.reject(new Error('시김새 오디오 프로세서를 사용할 수 없습니다. 지원되는 데스크톱 앱 또는 보안 연결에서 열어 주세요.'))
  const promise = import('./worklet-url.js')
    .then(({ default: url }) => context.audioWorklet.addModule(url))
    // Without the module (not built, opted out, failed to compile) the worklet keeps the TS kernels.
    .then(() => garakModule())
    .then(module => { if (module) rustModules.set(context, module); ready.add(context) })
    .catch(error => {
      prepared.delete(context)
      throw new Error(`시김새 오디오 프로세서를 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`)
    })
  prepared.set(context, promise)
  return promise
}

/** For the effects that also have a Web Audio implementation: never fails their preparation. */
export const prepareRustEffect = (context: BaseAudioContext): Promise<void> => prepareSigimsae(context).catch(() => undefined)

/** True when this context runs the Rust kernels (EQ, filter, compressor, drive and reverb then use them too). */
export const rustEffectsReady = (context: BaseAudioContext): boolean => ready.has(context) && rustModules.has(context)

// --- Reverb impulse responses: built on the main thread, copied by the worklet --------------------

const mainThreadDsp = new WeakMap<WebAssembly.Module, GarakWasm | null>()
/** Kernels per (rate, space, size); a few recent ones so toggling a space back costs nothing. */
const reverbKernelCache = new Map<string, Float32Array>()
const REVERB_CACHE_ENTRIES = 4

interface ReverbShape { space: number; size: number; predelay: number }
const finite = (value: number | undefined, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
/** The parameters fixed when a reverb is built (garak-dsp `Reverb::new`); defaults as in reverb.ts. */
function reverbShape(params: Record<string, number>): ReverbShape {
  return {
    space: clamp(Math.round(finite(params.type, 0)), 0, 3),
    size: clamp(finite(params.size, 0.35), 0, 1),
    predelay: clamp(finite(params.predelay, 0), 0, 250),
  }
}
const sameShape = (a: ReverbShape, b: ReverbShape) => a.space === b.space && a.size === b.size && a.predelay === b.predelay

function reverbKernels(context: BaseAudioContext, shape: ReverbShape): Float32Array | null {
  const module = rustModules.get(context)
  if (!module) return null
  const key = `${context.sampleRate}|${shape.space}|${shape.size}`
  const cached = reverbKernelCache.get(key)
  if (cached) { reverbKernelCache.delete(key); reverbKernelCache.set(key, cached); return cached }
  let dsp = mainThreadDsp.get(module)
  if (dsp === undefined) {
    try { dsp = instantiateGarakWasm(module) } catch { dsp = null }
    mainThreadDsp.set(module, dsp)
  }
  const kernels = dsp?.buildReverbKernels(context.sampleRate, shape.space, shape.size) ?? null
  if (!kernels) return null
  reverbKernelCache.set(key, kernels)
  while (reverbKernelCache.size > REVERB_CACHE_ENTRIES) reverbKernelCache.delete(reverbKernelCache.keys().next().value!)
  return kernels
}

// --- The worklet-backed device graph shared by every kernel and Rust effect -----------------------

export interface WorkletGraphOptions {
  /** Post-effect spectrum (EQ, filter) or goniometer (utility) feed for the device view. */
  analysis?: 'spectrum' | 'stereo'
}

/**
 * A device graph around one `garak-sigimsae-v1` node. The node is created on the first update so its
 * initial parameters travel with construction (offline renders start with the saved values, not defaults).
 */
export function createWorkletGraph(context: BaseAudioContext, remember: RememberNode, type: RustEffectType, options: WorkletGraphOptions = {}): DeviceGraph {
  if (!ready.has(context)) throw new Error('이펙트를 만들기 전에 시김새 프로세서를 준비해야 합니다.')
  const module = rustModules.get(context)
  const input = remember(context.createGain())
  const output = remember(context.createGain())
  let node: AudioWorkletNode | null = null
  const analysisTap: DeviceAnalysisTap | undefined = options.analysis === 'stereo' ? createStereoScopeTap(context, output, remember)
    : options.analysis === 'spectrum' ? createAnalysisTap(context, output, remember) : undefined
  // Metering starts on the first read (a view is open) and arrives ~30 times a second.
  let reading: DynamicsReading | null = null, metering = false
  const dynamicsMeter: DynamicsMeterSource | undefined = METERED.has(type) ? {
    read() {
      if (!metering && node) { metering = true; node.port.postMessage({ type: 'meter', on: true }) }
      return reading
    },
  } : undefined
  // Reverb: what the running effect was built with; edits to it rebuild (throttled while a knob moves).
  const offline = 'startRendering' in context
  let built: ReverbShape | null = null
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null, lastRebuild = -Infinity
  let latest: { params: Record<string, number>; bpm: number } | null = null
  const postRebuild = () => {
    rebuildTimer = null
    if (!node || !latest) return
    const shape = reverbShape(latest.params)
    if (built && sameShape(shape, built)) return
    const kernels = reverbKernels(context, shape)
    if (!kernels) return
    built = shape
    lastRebuild = performance.now()
    node.port.postMessage({ type: 'rebuild', params: { ...latest.params }, bpm: latest.bpm, reverbKernels: kernels })
  }
  return {
    input, output, dynamicsMeter, ...(analysisTap ? { analysisTap } : {}),
    update(params, bpm, now) {
      if (!node) {
        const shape = type === 'reverb' && module ? reverbShape(params) : null
        const kernels = shape ? reverbKernels(context, shape) : null
        if (shape && kernels) built = shape
        node = remember(new AudioWorkletNode(context, 'garak-sigimsae-v1', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
          processorOptions: { type, params: { ...params }, bpm, ...(module ? { garakWasm: module } : {}), ...(kernels ? { reverbKernels: kernels } : {}) },
        }))
        node.onprocessorerror = () => context.dispatchEvent?.(new Event('error'))
        node.port.onmessage = event => {
          const data = event.data as { type?: string; input?: number; gain?: number; rust?: boolean } | undefined
          if (data?.type === 'meter' && typeof data.input === 'number' && typeof data.gain === 'number') reading = { input: data.input, gain: data.gain }
          else if (data?.type === 'backend') {
            if (data.rust) rustDspStats.rust += 1
            else {
              rustDspStats.fallback += 1
              if (module) console.warn(`[가락이음] ${type}: Rust 이펙트를 만들지 못해 ${type in KERNEL_DEFS ? 'TypeScript 커널' : '바이패스'}로 처리합니다.`)
            }
          }
        }
        input.connect(node).connect(output)
        return
      }
      node.port.postMessage({ type: 'params', params: { ...params }, bpm, at: now })
      if (built && !sameShape(reverbShape(params), built)) {
        latest = { params: { ...params }, bpm }
        const wait = offline ? 0 : lastRebuild + 80 - performance.now()
        if (wait <= 0) { if (rebuildTimer) clearTimeout(rebuildTimer); postRebuild() }
        else rebuildTimer ??= setTimeout(postRebuild, wait)
      }
    },
    schedule(events, bpm) {
      if (!events.length) return
      if (!node) this.update(events[0].params, bpm, events[0].at, false)
      // Automation glides in place; like native automation lanes it never rebuilds the reverb.
      node!.port.postMessage({ type: 'schedule', events: events.map(event => ({ at: event.at, params: { ...event.params }, ...(event.bpm === undefined ? {} : { bpm: event.bpm }) })), bpm })
    },
    dispose() {
      if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null }
      if (dynamicsMeter) dynamicsMeter.disposed = true
      if (analysisTap) unbindDeviceAnalysis(analysisTap)
      if (!node) return
      node.onprocessorerror = null
      node.port.onmessage = null
      try { node.port.postMessage({ type: 'dispose' }) } catch { /* Context may have closed. */ }
      node.port.close()
    },
  }
}

/** A kernel-backed effect: Rust when the module loaded, else the kernels.ts kernel in the same worklet. */
function kernelEffect(type: KernelType): RealtimeEffectModule {
  const definition = KERNEL_DEFS[type]
  return {
    id: type, kind: 'realtime-effect', stateVersion: 1, definition,
    prepare: prepareSigimsae,
    create(context, remember): DeviceGraph {
      if (!ready.has(context)) throw new Error(`${definition.name}을(를) 만들기 전에 시김새 프로세서를 준비해야 합니다.`)
      // Utility feeds its stereo image view (goniometer / correlation) from the real output.
      return createWorkletGraph(context, remember, type, type === 'utility' ? { analysis: 'stereo' } : {})
    },
    tailSeconds: (params, bpm) => kernelTailSeconds(type, params, bpm),
  }
}

export const delayEffect = kernelEffect('delay')
export const chorusEffect = kernelEffect('chorus')
export const phaserEffect = kernelEffect('phaser')
export const flangerEffect = kernelEffect('flanger')
export const tremoloEffect = kernelEffect('tremolo')
export const limiterEffect = kernelEffect('limiter')
export const gateEffect = kernelEffect('gate')
export const tapeEffect = kernelEffect('tape')
export const bitcrusherEffect = kernelEffect('bitcrusher')
export const utilityEffect = kernelEffect('utility')
