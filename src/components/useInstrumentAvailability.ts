import { useCallback, useSyncExternalStore } from 'react'
import type { AudioEngine, InstrumentId } from '../core/types'
import { canPlayInstrument } from '../audio/instrumentSupport'
import { wavetableBridgeStatus, WAVETABLE_UNAVAILABLE_STATUS } from '../devices/wavetable-synth/bridge'

/** Device disconnect/reconnect updates preview affordances without reopening a panel. */
export function useInstrumentAvailability(engine: AudioEngine): (instrument: InstrumentId) => boolean {
  const bridge = engine.wavetable
  const subscribe = useCallback((listener: () => void) => bridge?.subscribe(listener) ?? (() => {}), [bridge])
  const snapshot = useCallback(() => wavetableBridgeStatus(bridge), [bridge])
  useSyncExternalStore(subscribe, snapshot, () => WAVETABLE_UNAVAILABLE_STATUS)
  return instrument => canPlayInstrument(engine, instrument)
}
