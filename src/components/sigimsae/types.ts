import type { AudioEngine, EffectDevice } from '../../core/types'
import type { ParamDef } from '../../core/devices'

/** Undo label and merge key for a multi-parameter edit. */
export interface ParamsEditOptions { label?: string; mergeKey?: string }

/** What every graphical 시김새 editor receives. Views own their whole card body (graph + any knobs). */
export interface DeviceViewProps {
  device: EffectDevice
  /** Parameter definitions of this effect type, in display order. */
  defs: readonly ParamDef[]
  /** Current value of a parameter (defaults filled in). */
  value(id: string): number
  /** One parameter change; drags merge into one undo step per parameter. */
  onParam(id: string, value: number): void
  /**
   * Several parameters at once (one undo step), e.g. dragging an EQ node changes freq + gain.
   * Calls sharing a `mergeKey` merge into one undo step (pass a fresh key per drag gesture).
   */
  onParams(params: Record<string, number>, options?: ParamsEditOptions): void
  engine: AudioEngine
  trackId: string
  color?: string
  bpm?: number
}
export type DeviceView = (props: DeviceViewProps) => React.ReactElement | null
