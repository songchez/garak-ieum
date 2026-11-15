import type { DeviceView } from './types'
import { DelayView } from './space/DelayView'
import { ReverbView } from './space/ReverbView'
import { modView } from './space/ModView'
import { CrushView, satView } from './space/DriveView'
import { UtilityView } from './space/UtilityView'

/** Graphical editors for this group, keyed by effect type. Owned by one agent; register views here only. */
export const VIEWS: Record<string, DeviceView> = {
  delay: DelayView,
  reverb: ReverbView,
  chorus: modView('chorus'),
  phaser: modView('phaser'),
  flanger: modView('flanger'),
  tremolo: modView('tremolo'),
  drive: satView('drive'),
  tape: satView('tape'),
  bitcrusher: CrushView,
  utility: UtilityView,
}
