export interface EdgeSnapRequest {
  rawDelta: number
  gridDelta: number
  movingEdges: readonly number[]
  targetEdges: readonly number[]
  ppb: number
  enabled: boolean
  minDelta?: number
  maxDelta?: number
  tolerancePx?: number
}

/** A single shared delta preserves the spacing of a selection and never quantizes other objects. */
export function snapToEdges({ rawDelta, gridDelta, movingEdges, targetEdges, ppb, enabled, minDelta = -Infinity, maxDelta = Infinity, tolerancePx = 6 }: EdgeSnapRequest): { delta: number; guide: number | null } {
  const clamp = (value: number) => Math.min(maxDelta, Math.max(minDelta, value))
  const fallback = { delta: clamp(gridDelta), guide: null }
  if (!enabled || !(ppb > 0) || !Number.isFinite(rawDelta) || !Number.isFinite(ppb)) return fallback
  const targets = [...new Set(targetEdges.filter(Number.isFinite))].sort((a, b) => a - b)
  if (!targets.length) return fallback
  let bestDistance = tolerancePx / ppb + 1e-9
  let result: { delta: number; guide: number | null } = fallback
  for (const edge of movingEdges) {
    if (!Number.isFinite(edge)) continue
    // Only the two nearest sorted edges can win. A large multi-selection must not create an
    // all-pairs comparison on every pointer event.
    const desired = edge + clamp(rawDelta)
    let low = 0, high = targets.length
    while (low < high) { const middle = (low + high) >>> 1; if (targets[middle] < desired) low = middle + 1; else high = middle }
    for (const index of [low - 1, low]) {
      const target = targets[index]
      if (target === undefined) continue
      const delta = target - edge
      if (delta < minDelta - 1e-9 || delta > maxDelta + 1e-9) continue
      const distance = Math.abs(delta - rawDelta)
      if (distance < bestDistance) { bestDistance = distance; result = { delta, guide: target } }
    }
  }
  return result
}
