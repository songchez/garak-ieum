import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { wheelFactor, type ZoomHandle } from '../core/zoom'

/** Publishes an area's zoom actions so the app's key dispatcher can reach the focused area. */
export function useZoomHandle(ref: RefObject<ZoomHandle | null> | undefined, handle: ZoomHandle) {
  const latest = useRef(handle)
  latest.current = handle
  useEffect(() => {
    if (!ref) return
    const published: ZoomHandle = { zoom: (axis, factor) => latest.current.zoom(axis, factor), fit: () => latest.current.fit() }
    ref.current = published
    return () => { if (ref.current === published) ref.current = null }
  }, [ref])
}

export interface ZoomWheelHandlers {
  /** factor > 1 zooms in; pointer is relative to the element's left edge. */
  onZoomX?: (factor: number, pointerX: number, event: WheelEvent) => void
  /** factor > 1 zooms in; pointer is relative to the element's top edge. */
  onZoomY?: (factor: number, pointerY: number, event: WheelEvent) => void
}

/**
 * Ctrl/⌘ + wheel (and trackpad pinch, which browsers send as a Ctrl wheel) zooms
 * horizontally; Ctrl/⌘ + Shift + wheel or Alt + wheel zooms vertically. Plain and
 * Shift wheel keep scrolling natively; the event is consumed only when handled.
 */
export function useZoomWheel(ref: RefObject<HTMLElement | null>, handlers: ZoomWheelHandlers, enabled = true) {
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const wheel = (e: WheelEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const vertical = (mod && e.shiftKey) || (e.altKey && !mod)
      if (!mod && !vertical) return
      const handler = vertical ? latest.current.onZoomY : latest.current.onZoomX
      if (!handler) return
      // Shift turns a vertical wheel into deltaX in some browsers.
      const delta = e.deltaY || e.deltaX
      e.preventDefault()
      if (!delta) return
      const r = el.getBoundingClientRect()
      handler(wheelFactor(delta, e.deltaMode), vertical ? e.clientY - r.top : e.clientX - r.left, e)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [ref, enabled])
}
