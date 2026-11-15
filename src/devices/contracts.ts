import type { EffectType } from '../core/types.js'
import type { DynamicsMeterSource } from './effects/dynamicsMeter.js'

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

/** Nodes are owned and disconnected by the host through remember(). */
export type RememberNode = <T extends AudioNode>(node: T) => T

export interface DeviceGraph {
  input: AudioNode
  output: AudioNode
  /** Release worklet ports and internal sources before the host disconnects nodes. */
  dispose?(): void
  update(params: Record<string, number>, bpm: number, now: number, smooth: boolean): void
  /** Automation (docs/AUTOMATION.md): parameter sets taking effect at context times, sorted. Devices without it
   * receive one update(params, bpm, at, true) per event; AudioParam-backed devices schedule those exactly. */
  schedule?(events: readonly { at: number; params: Record<string, number>; bpm?: number }[], bpm: number): void
  /** Compressor/limiter/gate: live input level and gain reduction for the device view (realtime only). */
  dynamicsMeter?: DynamicsMeterSource
}

/** Built-in numeric state remains compatible with existing Device.params files. */
export interface RealtimeEffectModule {
  readonly id: EffectType
  readonly kind: 'realtime-effect'
  readonly stateVersion: 1
  readonly definition: EffectDef
  /** Register per-context processors before synchronous create(), without audio nodes on import. */
  prepare?(context: BaseAudioContext): Promise<void>
  create(context: BaseAudioContext, remember: RememberNode): DeviceGraph
  /** Legacy export tail allowance, including the release guard where required. */
  tailSeconds(params: Record<string, number>, bpm: number): number
}
