import type { DeviceGraph, RealtimeEffectModule } from '../contracts.js'
import { kernelTailSeconds } from './kernels.js'
import { KERNEL_DEFS, type KernelType } from './sigimsaeDefs.js'

const prepared = new WeakMap<BaseAudioContext, Promise<void>>()
const ready = new WeakSet<BaseAudioContext>()

/** Registers the shared 시김새 processor once per realtime or offline context. */
export function prepareSigimsae(context: BaseAudioContext): Promise<void> {
  const existing = prepared.get(context)
  if (existing) return existing
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.reject(new Error('시김새 오디오 프로세서를 사용할 수 없습니다. 지원되는 데스크톱 앱 또는 보안 연결에서 열어 주세요.'))
  const promise = import('./worklet-url.js')
    .then(({ default: url }) => context.audioWorklet.addModule(url))
    .then(() => { ready.add(context) })
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
      return {
        input, output,
        update(params, bpm) {
          if (!node) {
            node = remember(new AudioWorkletNode(context, 'garak-sigimsae-v1', {
              numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
              processorOptions: { type, params: { ...params }, bpm },
            }))
            node.onprocessorerror = () => context.dispatchEvent?.(new Event('error'))
            input.connect(node).connect(output)
            return
          }
          node.port.postMessage({ type: 'params', params: { ...params }, bpm })
        },
        dispose() {
          if (!node) return
          node.onprocessorerror = null
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
