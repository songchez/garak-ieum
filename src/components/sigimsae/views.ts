import type { DeviceView } from './types'
import { VIEWS as EQ_VIEWS } from './views-eq'
import { VIEWS as DYNAMICS_VIEWS } from './views-dynamics'
import { VIEWS as SPACE_VIEWS } from './views-space'

const ALL: Record<string, DeviceView> = { ...EQ_VIEWS, ...DYNAMICS_VIEWS, ...SPACE_VIEWS }
/** The graphical editor for an effect type, or undefined to fall back to the knob grid. */
export function deviceView(type: string): DeviceView | undefined { return ALL[type] }
export type { DeviceView, DeviceViewProps } from './types'
