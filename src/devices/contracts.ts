import type { EffectType } from '../core/types.js'

export type ParamUnit = 'hz' | 'db' | 's' | 'ms' | 'pct' | 'signed' | 'ct' | 'st' | 'x' | 'q' | 'ratio' | 'gain' | 'pan'

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
  name: string
  short: string
  params: readonly ParamDef[]
}

/** Nodes are owned and disconnected by the host through remember(). */
export type RememberNode = <T extends AudioNode>(node: T) => T

export interface DeviceGraph {
  input: AudioNode
  output: AudioNode
  update(params: Record<string, number>, bpm: number, now: number, smooth: boolean): void
}

/** Built-in numeric state remains compatible with existing Device.params files. */
export interface RealtimeEffectModule {
  readonly id: EffectType
  readonly kind: 'realtime-effect'
  readonly stateVersion: 1
  readonly definition: EffectDef
  create(context: BaseAudioContext, remember: RememberNode): DeviceGraph
  /** Legacy export tail allowance, including the release guard where required. */
  tailSeconds(params: Record<string, number>, bpm: number): number
}
