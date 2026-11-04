import type { WavetablePatch } from '../model'
import type { WavetableNativeBridge } from '../bridge'

/** Controlled editor API. Rendering it never opens an audio device. */
export interface WavetableSynthProps {
  patch: WavetablePatch
  onPatchChange: (patch: WavetablePatch, label: string, mergeKey?: string) => void
  onClose: () => void
  /** Native patch and preview events are scoped to the current track. */
  trackId: string
  trackName?: string
  nativeBridge?: WavetableNativeBridge
  bpm?: number
  /** Optional application save entry; project changes already use onPatchChange. */
  onSave?: () => void
}
