import type { DeviceGraph, RememberNode } from '../contracts.js'
import { instantiateGarakWasm, type GarakWasm } from '../../audio/rust/garakWasm.js'
import { rigStructureKey } from '../../audio/rust/guitarRigRust.js'
import type { GuitarTunerTap } from './tuner.js'

/**
 * The guitar rig on the Rust core (docs/RUST.md, "기타 랙"): one `garak-guitar-rig-v1` worklet node running
 * the desktop's garak-dsp rig, so web and desktop render the same rig. index.ts uses it whenever the page's
 * garak-dsp.wasm has the rig exports, and keeps the Web Audio rig (its `buildRig`) as the fallback: no
 * module, `garak.rustDsp=0`, or a worklet that could not create the Rust rig (it then switches in place).
 */
export type RigGraph = DeviceGraph & { dispose(): void; tunerTap: GuitarTunerTap }

const mainThread = new WeakMap<WebAssembly.Module, GarakWasm | null>()
/** A main-thread instance of the module for kernel preparation, or null when it has no rig exports. */
export function rigMainThreadDsp(module: WebAssembly.Module): GarakWasm | null {
  let dsp = mainThread.get(module)
  if (dsp === undefined) {
    try { dsp = instantiateGarakWasm(module) } catch { dsp = null }
    if (dsp && !dsp.hasGuitarRig()) dsp = null
    mainThread.set(module, dsp)
  }
  return dsp
}

/** Plate kernels per (rate, Decay as float), a few recent ones so toggling a reverb back costs nothing. */
const kernelCache = new Map<string, Float32Array>()
const KERNEL_CACHE_ENTRIES = 6

/** Kernels for every reverb copy the rig in `params` builds (index = copy), prepared here on the main thread. */
function plateKernels(dsp: GarakWasm, sampleRate: number, params: Record<string, number>): (Float32Array | null)[] {
  return dsp.rigReverbDecays(params).map(decay => {
    if (decay === null) return null
    const key = `${sampleRate}|${Math.fround(decay)}`
    const cached = kernelCache.get(key)
    if (cached) { kernelCache.delete(key); kernelCache.set(key, cached); return cached }
    const kernels = dsp.buildReverbKernels(sampleRate, 0, decay)
    if (!kernels) return null
    kernelCache.set(key, kernels)
    while (kernelCache.size > KERNEL_CACHE_ENTRIES) kernelCache.delete(kernelCache.keys().next().value!)
    return kernels
  })
}

export interface RustRigHooks {
  /** A rig node with the host's error handling (index.ts createProcessor). */
  node(options: AudioWorkletNodeOptions): AudioWorkletNode
  /** The Web Audio rig, for a worklet that could not create the Rust rig. */
  fallback(): RigGraph
  /** Which path a node took (diagnostics). */
  backend?(rust: boolean): void
}

export function createRustRigGraph(context: BaseAudioContext, remember: RememberNode, module: WebAssembly.Module, dsp: GarakWasm, hooks: RustRigHooks): RigGraph {
  const defs = dsp.rigParamDefs()
  const input = remember(context.createGain())
  const output = remember(context.createGain())
  // Tuner: the worklet's second output is the signal at the tuner's rack position; the silent sink keeps
  // the analyser pulled by the graph in every browser.
  const analyser = remember(context.createAnalyser())
  analyser.fftSize = context.sampleRate > 50000 ? 8192 : 4096
  const tunerSink = remember(context.createGain())
  tunerSink.gain.value = 0
  analyser.connect(tunerSink).connect(output)
  const tunerTap: GuitarTunerTap = { analyser, sampleRate: context.sampleRate }
  const offline = 'startRendering' in context
  let node: AudioWorkletNode | null = null
  let fallback: RigGraph | null = null
  let disposed = false
  let built = ''
  let latest: { params: Record<string, number>; bpm: number; now: number } | null = null
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null, lastRebuild = -Infinity

  const switchToFallback = () => {
    if (fallback || disposed) return
    fallback = hooks.fallback()
    if (node) { input.disconnect(node); node.disconnect() }
    input.connect(fallback.input)
    fallback.output.connect(output)
    // The analyser passes its input through: the fallback's tuner tap feeds this graph's tap.
    fallback.tunerTap.analyser.connect(analyser)
    if (latest) fallback.update(latest.params, latest.bpm, latest.now, false)
  }
  const postRebuild = () => {
    rebuildTimer = null
    if (!node || !latest || fallback || disposed) return
    const key = rigStructureKey(latest.params, defs)
    if (key === built) return
    built = key
    lastRebuild = performance.now()
    node.port.postMessage({ type: 'rebuild', params: { ...latest.params }, kernels: plateKernels(dsp, context.sampleRate, latest.params) })
  }

  return {
    input, output, tunerTap,
    update(params, bpm, now, smooth) {
      if (disposed) return
      latest = { params: { ...params }, bpm, now }
      if (fallback) { fallback.update(params, bpm, now, smooth); return }
      if (!node) {
        // Created on the first update so the initial parameters travel with construction (offline renders
        // start with the saved values, not defaults).
        built = rigStructureKey(params, defs)
        node = hooks.node({
          numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [2, 1], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
          processorOptions: { garakWasm: module, params: { ...params }, kernels: plateKernels(dsp, context.sampleRate, params) },
        })
        node.port.onmessage = event => {
          const data = event.data as { type?: string; rust?: boolean } | undefined
          if (data?.type !== 'backend') return
          hooks.backend?.(!!data.rust)
          if (!data.rust) switchToFallback()
        }
        input.connect(node)
        node.connect(output, 0, 0)
        node.connect(analyser, 1, 0)
        return
      }
      node.port.postMessage({ type: 'params', params: { ...params }, at: now })
      if (rigStructureKey(params, defs) !== built) {
        // A rack or reverb edit: a new rig adopts the old one's state (throttled while a knob moves).
        const wait = offline ? 0 : lastRebuild + 80 - performance.now()
        if (wait <= 0) { if (rebuildTimer) clearTimeout(rebuildTimer); postRebuild() }
        else rebuildTimer ??= setTimeout(postRebuild, wait)
      }
    },
    schedule(events, bpm) {
      if (disposed || !events.length) return
      if (!node && !fallback) this.update(events[0].params, events[0].bpm ?? bpm, events[0].at, false)
      if (fallback) { for (const event of events) fallback.update(event.params, event.bpm ?? bpm, event.at, true); return }
      // Automation glides in place; like native automation lanes it never rebuilds the rig.
      node!.port.postMessage({ type: 'schedule', events: events.map(event => ({ at: event.at, params: { ...event.params } })) })
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null }
      fallback?.dispose()
      if (!node) return
      node.onprocessorerror = null
      node.port.onmessage = null
      try { node.port.postMessage({ type: 'dispose' }) } catch { /* Context may have closed. */ }
      node.port.close()
    },
  }
}
