import type { EffectModule, ParamDef } from '../contracts.js'
import { KERNEL_DEFS, type KernelType } from './sigimsaeDefs.js'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Parameter reader clamped to each definition's range, with its default for missing values. */
export function readParams(defs: readonly ParamDef[], params: Record<string, number> | undefined): (id: string) => number {
  return id => {
    const def = defs.find(d => d.id === id)!
    const value = params?.[id]
    return clamp(typeof value === 'number' && Number.isFinite(value) ? value : def.default, def.min, def.max)
  }
}

/** The longest delay line of the studio delay (garak-dsp `Delay`). */
export const DELAY_MAX_SECONDS = 3.9
export function delaySeconds(p: (id: string) => number, bpm: number): number {
  return Math.min(DELAY_MAX_SECONDS, p('sync') >= 0.5 ? p('time') * 60 / bpm : p('ms') * 0.001)
}

/** Export tail allowance for the sample-processed 시김새 (seconds), including the 0.85 s guard. */
export function kernelTailSeconds(type: KernelType, params: Record<string, number>, bpm: number): number {
  const p = readParams(KERNEL_DEFS[type].params, params)
  switch (type) {
    case 'delay': {
      if (p('amount') <= 0) return 0
      const feedback = p('feedback')
      const repeats = feedback > 0.01 ? Math.ceil(Math.log(0.001) / Math.log(feedback)) : 1
      return Math.min(30, (delaySeconds(p, bpm) + p('age') * 0.0026) * (repeats + 1) + 0.85)
    }
    case 'chorus': return 0.05
    case 'flanger': {
      const feedback = p('feedback')
      const repeats = feedback > 0.01 ? Math.ceil(Math.log(0.001) / Math.log(feedback)) : 1
      return 0.0065 * (repeats + 1) + 0.05
    }
    case 'phaser': return 0.05
    case 'gate': return (p('hold') + p('release') * 1.5) * 0.001
    case 'limiter': return p('release') * 0.007
    default: return 0
  }
}

function kernelEffect(type: KernelType): EffectModule {
  return { id: type, stateVersion: 1, definition: KERNEL_DEFS[type], tailSeconds: (params, bpm) => kernelTailSeconds(type, params, bpm) }
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
