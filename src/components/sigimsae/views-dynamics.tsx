import type { DeviceView } from './types'
import { DynamicsCard } from './dynamics/DynamicsCard'

/** Graphical editors for this group, keyed by effect type. Owned by one agent; register views here only. */
export const VIEWS: Record<string, DeviceView> = {
  compressor: props => <DynamicsCard {...props} kind="compressor"/>,
  limiter: props => <DynamicsCard {...props} kind="limiter"/>,
  gate: props => <DynamicsCard {...props} kind="gate"/>,
}
