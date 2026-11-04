import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { WavetablePreviewSession, WAVETABLE_UNAVAILABLE_STATUS, wavetableBridgeStatus } from '../bridge'
import type { WavetableNativeBridge, WavetablePreviewStatus } from '../bridge'
import type { WavetablePatch } from '../model'

const EMPTY: WavetablePreviewStatus = Object.freeze({ ready: false, pending: false, revision: 0, error: null })
const noopSubscribe = () => () => {}

/** Editing remains local; the host alone decides whether audition can be enabled. */
export function useNativePreview(bridge: WavetableNativeBridge | undefined, trackId: string, patch: WavetablePatch) {
  const [owner, setOwner] = useState<{ session: WavetablePreviewSession; bridge: WavetableNativeBridge | undefined; trackId: string } | null>(null)
  const [acknowledged, setAcknowledged] = useState<WavetablePatch | null>(null)
  const currentPatch = useRef(patch); currentPatch.current = patch
  const subscribeBridge = useCallback((listener: () => void) => bridge?.subscribe(listener) ?? (() => {}), [bridge])
  const snapshotBridge = useCallback(() => wavetableBridgeStatus(bridge), [bridge])
  const engine = useSyncExternalStore(subscribeBridge, snapshotBridge, () => WAVETABLE_UNAVAILABLE_STATUS)
  const session = owner && owner.bridge === bridge && owner.trackId === trackId ? owner.session : null
  const subscribe = useCallback((listener: () => void) => session?.subscribe(listener) ?? noopSubscribe(), [session])
  const snapshot = useCallback(() => session?.getSnapshot() ?? EMPTY, [session])
  const status = useSyncExternalStore(subscribe, snapshot, () => EMPTY)

  useEffect(() => {
    const next = new WavetablePreviewSession(bridge, trackId)
    setOwner({ session: next, bridge, trackId }); setAcknowledged(null)
    return () => next.dispose()
  }, [bridge, trackId])
  useEffect(() => {
    if (!session) return
    let current = true
    setAcknowledged(null)
    void session.applyPatch(patch).then(accepted => { if (current && accepted && currentPatch.current === patch) setAcknowledged(patch) })
    return () => { current = false }
  // A device reopen can publish unavailable/available in one React batch.
  // Observe the immutable snapshot too so the identical patch is reapplied
  // even when the final boolean and the selected backend are unchanged.
  }, [session, patch, engine])
  useEffect(() => {
    const release = () => session?.allNotesOff()
    window.addEventListener('blur', release)
    return () => { window.removeEventListener('blur', release); release() }
  }, [session])

  const ready = !!session && engine.available && status.ready && acknowledged === patch
  return {
    engine, ready, pending: engine.available && (!ready || status.pending), error: status.error,
    noteOn: (note: number, velocity: number) => { if (ready) session?.noteOn(note, velocity) },
    noteOff: (note: number) => session?.noteOff(note),
    allNotesOff: () => session?.allNotesOff(),
  }
}
