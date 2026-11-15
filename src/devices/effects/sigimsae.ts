import type { DeviceGraph, RealtimeEffectModule } from '../contracts.js'
import { kernelTailSeconds } from './kernels.js'
import { KERNEL_DEFS, type KernelType } from './sigimsaeDefs.js'
import type { DynamicsMeterSource, DynamicsReading } from './dynamicsMeter.js'
import { createStereoScopeTap, unbindDeviceAnalysis } from './analysis.js'
import { rustDspRequested } from '../../audio/rust/flag.js'
import { loadGarakWasmModule } from '../../audio/rust/garakWasm.js'

/** Kernels that report input level and gain reduction to the device views. */
const METERED: ReadonlySet<KernelType> = new Set<KernelType>(['limiter', 'gate'])

const prepared = new WeakMap<BaseAudioContext, Promise<void>>()
const ready = new WeakSet<BaseAudioContext>()
/** Rust/WASM kernels (docs/RUST.md): the compiled module per context when `rustDspRequested()`, else absent. */
const rustModules = new WeakMap<BaseAudioContext, WebAssembly.Module>()
const baseUrl = () => (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'

/** Registers the shared 시김새 processor once per realtime or offline context. */
export function prepareSigimsae(context: BaseAudioContext): Promise<void> {
  const existing = prepared.get(context)
  if (existing) return existing
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.reject(new Error('시김새 오디오 프로세서를 사용할 수 없습니다. 지원되는 데스크톱 앱 또는 보안 연결에서 열어 주세요.'))
  const promise = import('./worklet-url.js')
    .then(({ default: url }) => context.audioWorklet.addModule(url))
    // Off by default: without the flag (or the built artifact) the worklet keeps the TS kernels.
    .then(() => rustDspRequested() ? loadGarakWasmModule(baseUrl()) : null)
    .then(module => { if (module) rustModules.set(context, module); ready.add(context) })
    .catch(error => {
      prepared.delete(context)
      throw new Error(`시김새 오디오 프로세서를 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`)
    })
  prepared.set(context, promise)
  return promise
}

/**
 * A kernel-backed effect. The worklet node is created on the first update so its initial
 * parameters travel with construction (offline renders start with the saved values, not defaults).
 */
function kernelEffect(type: KernelType): RealtimeEffectModule {
  const definition = KERNEL_DEFS[type]
  return {
    id: type, kind: 'realtime-effect', stateVersion: 1, definition,
    prepare: prepareSigimsae,
    create(context, remember): DeviceGraph {
      if (!ready.has(context)) throw new Error(`${definition.name}을(를) 만들기 전에 시김새 프로세서를 준비해야 합니다.`)
      const input = remember(context.createGain())
      const output = remember(context.createGain())
      let node: AudioWorkletNode | null = null
      // Utility feeds its stereo image view (goniometer / correlation) from the real output.
      const analysisTap = type === 'utility' ? createStereoScopeTap(context, output, remember) : undefined
      // Metering starts on the first read (a view is open) and arrives ~30 times a second.
      let reading: DynamicsReading | null = null, metering = false
      const dynamicsMeter: DynamicsMeterSource | undefined = METERED.has(type) ? {
        read() {
          if (!metering && node) {
            metering = true
            node.port.onmessage = event => {
              const data = event.data as { type?: string; input?: number; gain?: number } | undefined
              if (data?.type === 'meter' && typeof data.input === 'number' && typeof data.gain === 'number') reading = { input: data.input, gain: data.gain }
            }
            node.port.postMessage({ type: 'meter', on: true })
          }
          return reading
        },
      } : undefined
      return {
        input, output, dynamicsMeter, ...(analysisTap ? { analysisTap } : {}),
        update(params, bpm, now) {
          if (!node) {
            node = remember(new AudioWorkletNode(context, 'garak-sigimsae-v1', {
              numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
              processorOptions: { type, params: { ...params }, bpm, ...(rustModules.has(context) ? { garakWasm: rustModules.get(context) } : {}) },
            }))
            node.onprocessorerror = () => context.dispatchEvent?.(new Event('error'))
            input.connect(node).connect(output)
            return
          }
          node.port.postMessage({ type: 'params', params: { ...params }, bpm, at: now })
        },
        schedule(events, bpm) {
          if (!events.length) return
          if (!node) this.update(events[0].params, bpm, events[0].at, false)
          node!.port.postMessage({ type: 'schedule', events: events.map(event => ({ at: event.at, params: { ...event.params }, ...(event.bpm === undefined ? {} : { bpm: event.bpm }) })), bpm })
        },
        dispose() {
          if (dynamicsMeter) dynamicsMeter.disposed = true
          if (analysisTap) unbindDeviceAnalysis(analysisTap)
          if (!node) return
          node.onprocessorerror = null
          node.port.onmessage = null
          try { node.port.postMessage({ type: 'dispose' }) } catch { /* Context may have closed. */ }
          node.port.close()
        },
      }
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
