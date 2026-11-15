import type { DeviceView } from './types'
import { EqView } from './eq/EqView'
import { FilterView } from './eq/FilterView'

/** Graphical editors for this group, keyed by effect type. Owned by one agent; register views here only. */
export const VIEWS: Record<string, DeviceView> = {
  eq: EqView,
  filter: FilterView,
}
