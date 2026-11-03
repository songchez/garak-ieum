import { createContext, useCallback, useContext, useEffect, useId, useRef } from 'react'

export interface HistoryGestureHost {
  beginGesture(id: string, label?: string): void
  endGesture(id: string): void
  cancelGesture(id: string): void
}

/** Optional outside the DAW, so the same controls remain usable in previews. */
export const HistoryGestureContext = createContext<HistoryGestureHost | null>(null)

export function useHistoryGesture(label: string) {
  const host = useContext(HistoryGestureContext)
  const id = useId()
  const latestLabel = useRef(label)
  latestLabel.current = label
  const begin = useCallback(() => host?.beginGesture(id, latestLabel.current), [host, id])
  const end = useCallback(() => host?.endGesture(id), [host, id])
  const cancel = useCallback(() => host?.cancelGesture(id), [host, id])
  useEffect(() => {
    window.addEventListener('blur', end)
    return () => { window.removeEventListener('blur', end); end() }
  }, [end])
  return { begin, end, cancel }
}
