import type { EffectType } from '../core/types.js'

export type ParamUnit = 'hz' | 'db' | 's' | 'ms' | 'pct' | 'signed' | 'ct' | 'st' | 'x' | 'q' | 'ratio' | 'gain' | 'pan' | 'bits'

export interface ParamDef {
  id: string
  label: string
  min: number
  max: number
  default: number
  unit: ParamUnit
  scale?: 'log'
  options?: readonly { value: number; label: string }[]
}

export interface EffectDef {
  /** Characterful display name (e.g. "대청 Hall"). */
  name: string
  /** Compact button label. */
  short: string
  /** Plain type label shown under the name (e.g. "리버브"). */
  label?: string
  params: readonly ParamDef[]
}

/**
 * A built-in effect: its catalog entry and the export tail estimate. The DSP itself is the Rust render engine's
 * (rust/garak-engine, on the web in garak-engine.wasm); numeric state stays compatible with existing Device.params files.
 */
export interface EffectModule {
  readonly id: EffectType
  readonly stateVersion: 1
  readonly definition: EffectDef
  /** Export tail allowance (seconds), including the release guard where required. */
  tailSeconds(params: Record<string, number>, bpm: number): number
}
